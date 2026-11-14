import XCTest
import WebKit
@testable import DucklingTablet

/// Loads an app package the way the app runner does, through AppSchemeHandler, in a real WKWebView: the page renders,
/// localStorage keeps a value across loads, the page is a secure context (the microphone and camera need one), its own
/// files load by fetch, ranges are answered, and nothing outside the packages is served.
@MainActor
final class AppSchemeHandlerTests: XCTestCase {
    private var web: WKWebView!
    private let id = "scheme-test"

    override func setUp() async throws {
        let dir = Packages.shared.dir(id)
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try """
        <!doctype html><title>t</title><body><h1 id="h">Hello from the package</h1>
        <script>window.ready = fetch('data.json').then(r => r.json()).then(j => { document.getElementById('h').dataset.word = j.word; });</script>
        """.write(to: dir.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        try #"{"word":"duck"}"#.write(to: dir.appendingPathComponent("data.json"), atomically: true, encoding: .utf8)
        try Data((0..<200).map { UInt8($0) }).write(to: dir.appendingPathComponent("clip.bin"))
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
    }

    override func tearDown() async throws { Packages.shared.uninstall(id) }

    private func load(_ path: String) async throws {
        let done = expectation(description: "load")
        let nav = Nav { done.fulfill() }
        web.navigationDelegate = nav
        web.load(URLRequest(url: URL(string: "\(AppSchemeHandler.origin)/apps/\(id)/\(path)")!))
        await fulfillment(of: [done], timeout: 20)
        XCTAssertNil(nav.error, "load failed: \(String(describing: nav.error))")
    }

    private func js(_ code: String) async throws -> Any? { try await web.callAsyncJavaScript(code, contentWorld: .page) }

    func testPackageLoadsWithStorageAndSecureContext() async throws {
        try await load("index.html")
        let v1 = try await js("await window.ready; return document.getElementById('h').textContent") as? String
        XCTAssertEqual(v1, "Hello from the package")
        let v2 = try await js("await window.ready; return document.getElementById('h').dataset.word") as? String
        XCTAssertEqual(v2, "duck")
        let v3 = try await js("return location.origin") as? String
        XCTAssertEqual(v3, AppSchemeHandler.origin)
        let v4 = try await js("return window.isSecureContext") as? Bool
        XCTAssertEqual(v4, true, "getUserMedia needs a secure context")
        let v5 = try await js("return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)") as? Bool
        XCTAssertEqual(v5, true)
        _ = try await js("localStorage.setItem('k', 'kept'); return 1")
        _ = try await js("await new Promise((ok, no) => { const r = indexedDB.open('t', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => ok(); r.onerror = () => no(r.error); }); return 1")
        try await load("index.html")
        let v6 = try await js("return localStorage.getItem('k')") as? String
        XCTAssertEqual(v6, "kept")
    }

    func testRangesAndRefusals() async throws {
        try await load("index.html")
        let range = try await js("const r = await fetch('clip.bin', { headers: { Range: 'bytes=10-19' } }); const b = new Uint8Array(await r.arrayBuffer()); return [r.status, b.length, b[0], r.headers.get('content-range')].join(',')") as? String
        XCTAssertEqual(range, "206,10,10,bytes 10-19/200")
        XCTAssertNil(AppSchemeHandler.file(for: URL(string: "\(AppSchemeHandler.origin)/apps/\(id)/../../Preferences/x")!))
        XCTAssertNil(AppSchemeHandler.file(for: URL(string: "\(AppSchemeHandler.origin)/other/\(id)/index.html")!))
        XCTAssertNil(AppSchemeHandler.file(for: URL(string: "\(AppSchemeHandler.scheme)://elsewhere/apps/\(id)/index.html")!))
        let v7 = try await js("return (await fetch('missing.js')).status") as? Int
        XCTAssertEqual(v7, 404)
    }
}


extension AppSchemeHandlerTests {
    /// A microphone request from a package page reaches the app runner's decision with the package's own origin, and
    /// getUserMedia resolves once it is granted. The workflow grants the simulator's microphone to the app first.
    func testMicrophoneRequestFromAPackage() async throws {
        let ui = Capture()
        web.uiDelegate = ui
        try await load("index.html")
        let result = try await js("""
            try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); return 'ok'; }
            catch (e) { return e.name + ': ' + e.message; }
            """) as? String
        print("MIC-PROBE getUserMedia=\(result ?? "nil") asked=\(ui.asked)")
        XCTAssertEqual(ui.asked.count, 1, "WebKit did not ask the app about the microphone")
        XCTAssertEqual(ui.asked.first?.scheme, AppSchemeHandler.scheme)
        XCTAssertEqual(ui.asked.first?.host, AppSchemeHandler.host)
        XCTAssertEqual(result, "ok")
    }
}

private final class Capture: NSObject, WKUIDelegate {
    var asked: [(scheme: String, host: String)] = []
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        asked.append((origin.protocol, origin.host))
        decisionHandler(AppViewController.allowsCapture(type, scheme: origin.protocol, host: origin.host, permissions: ["microphone"]) ? .grant : .deny)
    }
}

private final class Nav: NSObject, WKNavigationDelegate {
    var error: Error?
    let done: () -> Void
    init(_ done: @escaping () -> Void) { self.done = done }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done() }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { error = e; done() }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { error = e; done() }
}
