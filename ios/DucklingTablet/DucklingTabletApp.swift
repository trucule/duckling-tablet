import SwiftUI
import UIKit

// The iPad shell: one full-screen web view on the Duckling web app (home screen, Library, parent area), installed app
// packages run full screen on top of it, and the Screen Time lockdown and App Store subscription underneath.
@main
struct DucklingTabletApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        WindowGroup {
            ShellView()
                .ignoresSafeArea()
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        LocalServer.shared.start()
        NetworkStatus.shared.start()
        Billing.shared.listen()
        return true
    }
}

struct ShellView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> MainViewController { MainViewController() }
    func updateUIViewController(_ controller: MainViewController, context: Context) {}
}
