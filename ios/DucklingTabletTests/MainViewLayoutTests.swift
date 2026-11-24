import XCTest
import WebKit
@testable import DucklingTablet

/// The home screen's web view fills the screen. Build 56 made it inside a zero-size root view with an autoresizing mask
/// only, it stayed at zero size, and the iPad showed nothing but the background colour.
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
}
