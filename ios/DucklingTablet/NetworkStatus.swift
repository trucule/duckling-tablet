import Foundation
import Network

/// The connection the web app's parent area shows ("wifi", "cellular", "other" or "none").
final class NetworkStatus {
    static let shared = NetworkStatus()
    private let monitor = NWPathMonitor()
    private(set) var current = "other"
    var onChange: (() -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let s: String
            if path.status != .satisfied { s = "none" }
            else if path.usesInterfaceType(.wifi) { s = "wifi" }
            else if path.usesInterfaceType(.cellular) { s = "cellular" }
            else { s = "other" }
            DispatchQueue.main.async { self?.current = s; self?.onChange?() }
        }
        monitor.start(queue: DispatchQueue(label: "com.ducklingtablet.network"))
    }
}
