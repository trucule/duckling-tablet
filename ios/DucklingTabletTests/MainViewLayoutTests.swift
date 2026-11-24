import XCTest
import WebKit
@testable import DucklingTablet

/// The home screen's web view fills the screen and shows the web app. Build 56 made it inside a zero-size root view
/// with an autoresizing mask only; it stayed at zero size and the iPad showed nothing but the background colour.
@MainActor
final class MainViewLayoutTests: XCTestCase {
    func testWebViewFillsTheScreenAtEverySize() {
        let vc = MainViewController()
        vc.loadViewIfNeeded()
        let web = vc.view.subviews.first { $0 is WKWebView }
        XCTAssertNotNil(web, "no web view on the home screen")
        for size in [CGSize(width: 1024, height: 768), CGSize(width: 768, height: 1024), CGSize(width: 1366, height: 1024)] {
            vc.view.frame = CGRect(origin: .zero, size: size)
            vc.view.layoutIfNeeded()
            XCTAssertEqual(web?.frame, vc.view.bounds, "web view does not fill a \(size) screen")
        }
    }

    /// The live web app comes up in the home screen with the shell bridge: it renders text and sees DucklingShell.
    func testHomeScreenShowsTheWebApp() async throws {
        let vc = MainViewController()
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = vc
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let web = try XCTUnwrap(vc.view.subviews.first { $0 is WKWebView } as? WKWebView)
        var report = ""
        for _ in 0..<40 {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let r = try? await web.evaluateJavaScript("JSON.stringify({ url: location.href, text: (document.body && document.body.innerText || '').slice(0, 120), shell: !!window.DucklingShell, state: !!window.__ducklingState })") as? String
            report = r ?? "no answer"
            if report.contains("\"shell\":true"), !report.contains("\"text\":\"\"") { break }
        }
        print("HOME-PROBE frame=\(web.frame) subviews=\(vc.view.subviews.map { String(describing: type(of: $0)) }) page=\(report)")
        XCTAssertTrue(report.contains("\"shell\":true"), "the web app does not see DucklingShell: \(report)")
        XCTAssertFalse(report.contains("\"text\":\"\""), "the web app shows no text: \(report)")
    }
}
