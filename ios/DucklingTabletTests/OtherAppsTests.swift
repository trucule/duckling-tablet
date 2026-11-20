import XCTest
@testable import DucklingTablet

/// The id an iPad's pick is reported under: stable for one token, different for another, and a package name the
/// server accepts (backend/src/routes/devices.ts, PACKAGE). Tokens themselves come only from Apple's picker, so the
/// hash is checked on their encoding.
final class OtherAppsTests: XCTestCase {
    func testIdIsAStablePackageName() {
        let a = OtherApps.id(hashing: Data("token-a".utf8)), b = OtherApps.id(hashing: Data("token-b".utf8))
        XCTAssertEqual(a, OtherApps.id(hashing: Data("token-a".utf8)))
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a, "ios.app.h" + a.suffix(16))
        XCTAssertNotNil(a.range(of: #"^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$"#, options: .regularExpression))
        XCTAssertNotNil(a.suffix(16).range(of: #"^[0-9a-f]{16}$"#, options: .regularExpression))
    }

}
