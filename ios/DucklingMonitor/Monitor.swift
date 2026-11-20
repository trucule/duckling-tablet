import DeviceActivity
import ManagedSettings

/// The Screen Time side of other apps' daily limits (see OtherApps.swift in the app). iOS runs this extension when
/// a picked app reaches its minutes for the day, and at the start of each day. It shares the app group's picks and
/// the named settings store with the app; it never sees the child or the network.
final class Monitor: DeviceActivityMonitor {
    private let store = ManagedSettingsStore(named: ManagedSettingsStore.Name("duckling"))
    private let defaults = UserDefaults(suiteName: "group.com.ducklingtablet.app")

    private struct Pick: Decodable { var token: ApplicationToken; var minutes: Int }
    private var picks: [String: Pick] {
        guard let d = defaults?.data(forKey: "otherApps"), let p = try? JSONDecoder().decode([String: Pick].self, from: d) else { return [:] }
        return p
    }

    /// A new day: every app the parent picked opens again.
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        store.shield.applications = nil
    }

    /// An app used its minutes: shielded until the next interval starts.
    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        guard let pick = picks[event.rawValue] else { return }
        var shielded = store.shield.applications ?? []
        shielded.insert(pick.token)
        store.shield.applications = shielded
    }
}
