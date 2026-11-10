import UIKit
import WebKit

/// The home screen: the Duckling web app in a full-screen web view, with window.DucklingShell bridged to the iPad.
/// Only Duckling's own hosts and the parent's allowed websites load here.
final class MainViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let webApp = URL(string: "https://app.ducklingtablet.com/")!
    private var web: WKWebView!
    private let prefs = Prefs.shared
    private lazy var shellScript: String = {
        guard let u = Bundle.main.url(forResource: "shell", withExtension: "js"), let s = try? String(contentsOf: u) else { return "" }
        return s
    }()

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(WeakHandler(self), name: "duckling")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 1, green: 0.99, blue: 0.96, alpha: 1)
        view = web
        installScripts()
        web.load(URLRequest(url: Self.webApp))

        NetworkStatus.shared.onChange = { [weak self] in self?.pushState() }
        Billing.shared.onChange = { [weak self] in self?.pushState() }
        NotificationCenter.default.addObserver(self, selector: #selector(resumed), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(stateChanged), name: UIAccessibility.guidedAccessStatusDidChangeNotification, object: nil)
    }

    // ---- State the page reads synchronously ----------------------------------------------------------------------

    private func state() -> [String: Any] {
        var s: [String: Any] = [
            "shellVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "deviceToken": prefs.deviceToken,
            "pushToken": "",
            "installed": prefs.installed.filter { Packages.shared.exists($0.key) },
            "lockdown": Lockdown.shared.status(lockdownOn: prefs.lockdownOn),
            "network": NetworkStatus.shared.current,
            "price": Billing.shared.displayPrice,
        ]
        if let h = prefs.pinHash { s["pinHash"] = h }
        return s
    }

    private func stateJSON() -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: state()), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    /// The snapshot is part of the script that runs before the page on every load, and is pushed into a running page.
    private func installScripts() {
        let ucc = web.configuration.userContentController
        ucc.removeAllUserScripts()
        ucc.addUserScript(WKUserScript(source: "window.__ducklingState = \(stateJSON());\n\(shellScript)", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func pushState() {
        installScripts()
        js("window.__ducklingSetState && __ducklingSetState(\(stateJSON()))")
    }

    @objc private func stateChanged() { pushState() }

    @objc private func resumed() {
        LocalServer.shared.ensureRunning()
        Lockdown.shared.apply(on: prefs.lockdownOn, allowedHosts: prefs.allowedHosts)
        pushState()
        js("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()")
    }

    private func js(_ code: String) { DispatchQueue.main.async { self.web.evaluateJavaScript(code, completionHandler: nil) } }
    private func q(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: [s]), let a = String(data: d, encoding: .utf8) else { return "''" }
        return String(a.dropFirst().dropLast())
    }

    // ---- Messages from the page ----------------------------------------------------------------------------------

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let a = body["args"] as? [Any] ?? []
        let str = { (i: Int) -> String in a.count > i ? String(describing: a[i]) : "" }
        switch cmd {
        case "setDeviceToken": prefs.deviceToken = str(0); pushState()
        case "setPinHash": prefs.pinHash = str(0).isEmpty ? nil : str(0).lowercased(); pushState()
        case "installApp": install(id: str(0), version: str(1), url: str(2), sha256: str(3), signature: str(4), permissions: str(5))
        case "uninstallApp":
            Packages.shared.uninstall(str(0))
            var i = prefs.installed; i.removeValue(forKey: str(0)); prefs.installed = i
            pushState()
        case "openApp": openApp(str(0))
        case "requestScreenTime":
            Task { _ = await Lockdown.shared.requestScreenTime(); await MainActor.run { self.pushState() } }
        case "openSettings":
            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
        case "setLockdown":
            prefs.lockdownOn = (a.first as? Bool) ?? (str(0) == "true")
            Lockdown.shared.apply(on: prefs.lockdownOn, allowedHosts: prefs.allowedHosts)
            pushState()
        case "setAllowedHosts":
            prefs.allowedHosts = str(0).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
            Lockdown.shared.apply(on: prefs.lockdownOn, allowedHosts: prefs.allowedHosts)
        case "setChildInfo":
            prefs.childName = str(0)
            if !str(1).isEmpty { prefs.narratorVoice = str(1) }
        case "setChildLevels": prefs.childLevels = str(0)
        case "setChildId": prefs.childId = str(0)
        case "setAppAccountToken": prefs.appAccountToken = str(0)
        case "release": release()
        case "subscribe": billing { await Billing.shared.subscribe() }
        case "restorePurchases": billing { await Billing.shared.restore() }
        case "manageSubscription": Task { await Billing.shared.manage() }
        case "reload": web.reload()
        default: break
        }
    }

    private func billing(_ work: @escaping () async -> (String, String)) {
        Task {
            let (status, message) = await work()
            js("window.DucklingWeb && DucklingWeb.onBilling && DucklingWeb.onBilling(\(q(status)), \(q(message)))")
        }
    }

    private func install(id: String, version: String, url: String, sha256: String, signature: String, permissions: String) {
        Task {
            do {
                try await Packages.shared.install(id: id, url: url, sha256: sha256, signature: signature)
                var i = prefs.installed; i[id] = version; prefs.installed = i
                var p = prefs.permissions; p[id] = permissions.split(separator: ",").map { String($0) }; prefs.permissions = p
                await MainActor.run { self.pushState() }
                js("window.DucklingWeb && DucklingWeb.onInstall(\(q(id)), true, '')")
            } catch {
                js("window.DucklingWeb && DucklingWeb.onInstall(\(q(id)), false, \(q(error.localizedDescription)))")
            }
        }
    }

    private func openApp(_ id: String) {
        guard Packages.shared.exists(id), presentedViewController == nil else { return }
        let vc = AppViewController(appId: id)
        vc.modalPresentationStyle = .fullScreen
        present(vc, animated: false)
    }

    /// Lifts the lockdown and forgets everything. iOS lets no app delete itself, so the web app then asks the parent
    /// to remove Duckling from the home screen.
    private func release() {
        Lockdown.shared.release()
        prefs.clearAll()
        Packages.shared.removeAll()
        pushState()
    }

    // ---- Navigation ----------------------------------------------------------------------------------------------

    private func allowed(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return url.scheme == "about" }
        if Lockdown.ownHosts.contains(host) { return true }
        let hosts = prefs.allowedHosts
        return hosts.contains("*") || hosts.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        decisionHandler(allowed(url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Links that ask for a new window open in place when allowed.
        if let url = action.request.url, allowed(url) { webView.load(action.request) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

/// WKUserContentController holds its handlers strongly; this breaks the cycle with the view controller.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) { target?.userContentController(ucc, didReceive: message) }
}
