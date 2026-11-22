import CryptoKit
import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings

/// Other apps on the iPad (build plan, section 14). iOS lets no app list what else is installed, so a parent picks the
/// apps the child may open in Apple's own picker, in the parent area of this iPad; the picks are opaque tokens only
/// this iPad can read. A picked app is left out of the Screen Time shield while the lockdown is on, and a daily limit
/// per app is enforced by Screen Time itself: DeviceActivity counts the minutes and, at the limit, the monitor
/// extension (DucklingMonitor) shields that app until midnight. The child opens a picked app from the iPad's home
/// screen; Duckling cannot launch it and cannot bring itself back, so this works with the Screen Time lockdown
/// alone, not with Guided Access on.
///
/// The picks and their minutes live in the app group so the extension reads them too. Each pick gets a stable id,
/// `ios.app.h<hash>`, from its token, so the server and the portal can show "an app chosen on the iPad" with its
/// minutes; the name never leaves the iPad.
final class OtherApps {
    static let shared = OtherApps()
    static let group = "group.com.ducklingtablet.app"
    static let storeName = ManagedSettingsStore.Name("duckling")
    static let activity = DeviceActivityName("duckling.day")
    static let noLimit = 0

    private let defaults = UserDefaults(suiteName: OtherApps.group) ?? .standard
    // Created on first use, never in the simulator (Lockdown.screenTimeExists).
    private lazy var store = ManagedSettingsStore(named: OtherApps.storeName)
    private lazy var center = DeviceActivityCenter()

    struct Pick: Codable, Equatable { var token: ApplicationToken; var minutes: Int }

    /// What the parent picked, with each app's minutes a day (0 means no limit).
    var picks: [String: Pick] {
        get {
            guard let d = defaults.data(forKey: "otherApps"), let p = try? JSONDecoder().decode([String: Pick].self, from: d) else { return [:] }
            return p
        }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "otherApps") }
    }

    var tokens: Set<ApplicationToken> { Set(picks.values.map { $0.token }) }

    /// The id the server knows an app by: a hash of the token's encoding, which is stable on one iPad.
    static func id(for token: ApplicationToken) -> String { id(hashing: (try? JSONEncoder().encode(token)) ?? Data()) }

    /// `ios.app.h` and 16 hex digits: a package name by the server's rule (a letter, then word characters, dotted).
    static func id(hashing data: Data) -> String {
        let hex = SHA256.hash(data: data).prefix(8).map { String(format: "%02x", $0) }.joined()
        return "ios.app.h\(hex)"
    }

    /// The list the page and the server see: ids and minutes, no names.
    var summary: [[String: Any]] {
        picks.keys.sorted().map { ["package": $0, "dailyMinutes": picks[$0]!.minutes == OtherApps.noLimit ? NSNull() : picks[$0]!.minutes] }
    }

    /// Replaces the picks with a selection from the picker, keeping the minutes of apps picked before (new ones get
    /// 30 minutes).
    func update(selection: FamilyActivitySelection) {
        var next: [String: Pick] = [:]
        let old = picks
        for token in selection.applicationTokens {
            let id = OtherApps.id(for: token)
            next[id] = Pick(token: token, minutes: old[id]?.minutes ?? 30)
        }
        picks = next
    }

    func setMinutes(_ minutes: Int, for id: String) {
        var p = picks
        guard var pick = p[id] else { return }
        pick.minutes = minutes
        p[id] = pick
        picks = p
    }

    func remove(_ id: String) {
        var p = picks; p.removeValue(forKey: id); picks = p
    }

    var selection: FamilyActivitySelection {
        var s = FamilyActivitySelection()
        s.applicationTokens = tokens
        return s
    }

    /// The picked apps' place in the lockdown. Called with every lockdown change: with the lockdown on, the picks are
    /// left out of the shield and their daily limits are counted; off, nothing is counted and no limit shield stays.
    /// The lockdown is re-applied often (every hosts refresh, every return to the front), and restarting the
    /// monitoring resets the day's count on iOS before 17.4, so nothing is restarted unless the picks or the state
    /// changed since the last start.
    func apply(lockdownOn: Bool) {
        guard Lockdown.screenTimeExists else { return }
        let signature = lockdownOn ? picks.keys.sorted().map { "\($0):\(picks[$0]!.minutes)" }.joined(separator: ",") : ""
        if signature == (defaults.string(forKey: "otherAppsApplied") ?? "") { return }
        defaults.set(signature, forKey: "otherAppsApplied")
        stopMonitoring()
        guard lockdownOn, !picks.isEmpty else { store.shield.applications = nil; return }
        // A limit shield from earlier today stays only for apps still picked with a limit.
        let limited = Set(picks.values.filter { $0.minutes != OtherApps.noLimit }.map { $0.token })
        if let shielded = store.shield.applications { store.shield.applications = shielded.intersection(limited).isEmpty ? nil : shielded.intersection(limited) }
        var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
        for (id, pick) in picks where pick.minutes != OtherApps.noLimit {
            let threshold = DateComponents(minute: pick.minutes)
            if #available(iOS 17.4, *) {
                // Minutes used earlier today, before this start, count too.
                events[DeviceActivityEvent.Name(id)] = DeviceActivityEvent(applications: [pick.token], threshold: threshold, includesPastActivity: true)
            } else {
                events[DeviceActivityEvent.Name(id)] = DeviceActivityEvent(applications: [pick.token], threshold: threshold)
            }
        }
        let day = DeviceActivitySchedule(intervalStart: DateComponents(hour: 0, minute: 0), intervalEnd: DateComponents(hour: 23, minute: 59), repeats: true)
        do { try center.startMonitoring(OtherApps.activity, during: day, events: events); defaults.set(true, forKey: "otherAppsMonitoring") } catch { lastError = String(describing: error) }
    }

    /// Stops the day's monitoring, only when one was started: DeviceActivity's calls are synchronous.
    private func stopMonitoring() {
        guard defaults.bool(forKey: "otherAppsMonitoring") else { return }
        defaults.set(false, forKey: "otherAppsMonitoring")
        center.stopMonitoring([OtherApps.activity])
    }

    /// Everything gone: the picks, the monitoring and any limit shield (Remove Duckling, or the family released).
    func clear() {
        guard Lockdown.screenTimeExists else { picks = [:]; return }
        stopMonitoring()
        store.shield.applications = nil
        picks = [:]
        defaults.removeObject(forKey: "otherAppsApplied")
    }

    private(set) var lastError = ""
}
