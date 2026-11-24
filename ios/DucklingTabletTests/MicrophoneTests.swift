import XCTest
import WebKit
@testable import DucklingTablet

/// After a page has used the microphone, the iOS 27 simulator finished no further load in that test host, so this test
/// has a class and a web view of its own and runs after AppSchemeHandlerTests (classes run in name order).
final class MicrophoneTests: PackagePageTestCase {
    /// A microphone request from a package page reaches the app runner's decision with the package's own origin, and
    /// getUserMedia resolves once it is granted. The workflow grants the simulator's microphone to the app first.
    func testMicrophoneRequestFromAPackage() async throws {
        let ui = Capture()
        web.uiDelegate = ui
        try await load("index.html")
        let result = try await js("""
            try { const s = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('no answer in 10 s'), { name: 'Timeout' })), 10000))]); s.getTracks().forEach(t => t.stop()); return 'ok'; }
            catch (e) { return e.name + ': ' + e.message; }
            """, seconds: 30) as? String
        print("MIC-PROBE getUserMedia=\(result ?? "nil") asked=\(ui.asked)")
        XCTAssertEqual(ui.asked.count, 1, "WebKit did not ask the app about the microphone")
        XCTAssertEqual(ui.asked.first?.scheme, AppSchemeHandler.scheme)
        XCTAssertEqual(ui.asked.first?.host, AppSchemeHandler.host)
        XCTAssertEqual(result, "ok")
    }
}
