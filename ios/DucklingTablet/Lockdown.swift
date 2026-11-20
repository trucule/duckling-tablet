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
    /// The named store is shared with the DucklingMonitor extension, which shields a picked app at its daily limit.
    /// Builds before 1.1 used the unnamed store; its settings are cleared once so they do not stay applied underneath.
    private let store = ManagedSettingsStore(named: OtherApps.storeName)
    private let legacy = ManagedSettingsStore()

    /// Hosts the shell itself needs, always let through the web filter.
    static let ownHosts: Set<String> = ["app.ducklingtablet.com", "api.ducklingtablet.com", "parents.ducklingtablet.com", "ducklingtablet.com", "duckling.nyc3.cdn.digitaloceanspaces.com"]

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
        legacy.clearAllSettings()
        guard on, screenTimeApproved else { store.clearAllSettings(); OtherApps.shared.apply(lockdownOn: false); return }
        // Every app is shielded except the ones a parent picked in the parent area (OtherApps); their daily limits
        // are counted from here on.
        let picked = OtherApps.shared.tokens
        store.shield.applicationCategories = picked.isEmpty ? .all() : .all(except: picked)
        store.application.denyAppRemoval = true
        OtherApps.shared.apply(lockdownOn: true)
        if allowedHosts.contains("*") {
            // Travel mode: every website for its duration.
            store.webContent.blockedByFilter = nil
        } else {
            let hosts = Lockdown.ownHosts.union(allowedHosts.map { $0.lowercased() })
            store.webContent.blockedByFilter = .all(except: Set(hosts.map { WebDomain(domain: $0) }))
        }
    }

    func release() {
        OtherApps.shared.clear()
        legacy.clearAllSettings()
        store.clearAllSettings()
        AuthorizationCenter.shared.revokeAuthorization { _ in }
    }

    /// The shape the web app's setup steps read (Android names kept: homeRole is Screen Time, pinned is Guided Access).
    func status(lockdownOn: Bool) -> [String: Any] {
        let st = screenTimeApproved, ga = guidedAccess
        return ["homeRole": st, "deviceSecure": passcodeSet, "pinned": ga, "lockdownOn": lockdownOn, "screenTime": st, "guidedAccess": ga, "otherApps": OtherApps.shared.picks.count]
    }
}
