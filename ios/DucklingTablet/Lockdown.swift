import Foundation
import UIKit
import FamilyControls
import ManagedSettings
import LocalAuthentication

/// The iPad lockdown (build plan, section 14): Screen Time (Family Controls) shields every other app and filters
/// the web to Duckling's own hosts and the parent's allowlist, and stops Duckling from being deleted. Guided Access,
/// turned on by the parent in Settings, keeps the child inside Duckling itself. The P0.8 spike on a real iPad decides
/// what a child can still undo; that result goes into the build plan.
final class Lockdown {
    static let shared = Lockdown()
    private let store = ManagedSettingsStore()

    /// Hosts the shell itself needs, always let through the web filter.
    static let ownHosts: Set<String> = ["127.0.0.1", "app.ducklingtablet.com", "api.ducklingtablet.com", "parents.ducklingtablet.com", "ducklingtablet.com", "duckling.nyc3.cdn.digitaloceanspaces.com"]

    var screenTimeApproved: Bool { AuthorizationCenter.shared.authorizationStatus == .approved }
    var guidedAccess: Bool { UIAccessibility.isGuidedAccessEnabled }
    var passcodeSet: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    /// Asks for Screen Time access. On a parent-owned iPad this shows the system sheet, approved with the device
    /// passcode or Face ID.
    func requestScreenTime() async -> Bool {
        do { try await AuthorizationCenter.shared.requestAuthorization(for: .individual) } catch { return false }
        return screenTimeApproved
    }

    func apply(on: Bool, allowedHosts: [String]) {
        guard on, screenTimeApproved else { store.clearAllSettings(); return }
        store.shield.applicationCategories = .all()
        store.application.denyAppRemoval = true
        if allowedHosts.contains("*") {
            // Travel mode: every website for its duration.
            store.webContent.blockedByFilter = nil
        } else {
            let hosts = Lockdown.ownHosts.union(allowedHosts.map { $0.lowercased() })
            store.webContent.blockedByFilter = .all(except: Set(hosts.map { WebDomain(domain: $0) }))
        }
    }

    func release() {
        store.clearAllSettings()
        AuthorizationCenter.shared.revokeAuthorization { _ in }
    }

    /// The shape the web app's setup steps read (Android names kept: homeRole is Screen Time, pinned is Guided Access).
    func status(lockdownOn: Bool) -> [String: Bool] {
        let st = screenTimeApproved, ga = guidedAccess
        return ["homeRole": st, "deviceSecure": passcodeSet, "pinned": ga, "lockdownOn": lockdownOn, "screenTime": st, "guidedAccess": ga]
    }
}
