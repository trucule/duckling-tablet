import AVFoundation
import SwiftUI
import UIKit
import WebKit

/// The home screen: the Duckling web app in a full-screen web view, with window.DucklingShell bridged to the iPad.
/// Only Duckling's own hosts and the parent's allowed websites load here.
final class MainViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let webApp = URL(string: "https://app.ducklingtablet.com/")!
    private var web: WKWebView!
    private let prefs = Prefs.shared
    private let appleSignIn = AppleSignIn()
    private let homePill = UIButton(configuration: .filled())
    private let videoPill = UIButton(configuration: .filled())
    /// Hosts refused without the Video blocked button: advertising and analytics, and those a parent kept blocked.
    private var quietHosts: [String] = []
    /// Hosts the allowed websites could not reach since the home screen last took the list (takeBlockedHosts).
    private var refused: [String: [String: Any]] = [:]
    private var urlWatch: NSKeyValueObservation?
    /// Windows a website opened (a "Sign in with Google" window), shown over it until they close.
    private var popups: [WKWebView] = []
    /// The last request restarted to change the user agent (decidePolicyFor); the same address is never restarted twice
    /// in a row.
    private var restartedURL: URL?
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
        config.userContentController.add(WeakHandler(self), name: "ducklingRefused")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 1, green: 0.99, blue: 0.96, alpha: 1)
        // The page fills a plain root view, so a website's sign-in window and the Home pill can sit over it. It is
        // pinned with constraints: a web view made at zero size with only an autoresizing mask stayed at zero size, and
        // build 56 showed nothing but the background.
        let root = UIView(frame: UIScreen.main.bounds)
        root.backgroundColor = web.backgroundColor
        root.addSubview(web)
        pin(web, to: root)
        view = root
        installScripts()
        web.load(URLRequest(url: Self.webApp))
        addHomePill()

        NetworkStatus.shared.onChange = { [weak self] in self?.pushState() }
        Billing.shared.onChange = { [weak self] in self?.pushState() }
        NotificationCenter.default.addObserver(self, selector: #selector(resumed), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(stateChanged), name: UIAccessibility.guidedAccessStatusDidChangeNotification, object: nil)
    }

    // ---- A website from a tile opens in this view in place of the home screen; the Home pill shows over it ---------

    private func addHomePill() {
        var look = UIButton.Configuration.filled()
        look.title = prefs.homeTitle
        look.baseBackgroundColor = UIColor(white: 0.1, alpha: 0.55)
        look.baseForegroundColor = .white
        look.cornerStyle = .capsule
        look.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18)
        look.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in var b = a; b.font = .systemFont(ofSize: 18, weight: .bold); return b }
        homePill.configuration = look
        homePill.translatesAutoresizingMaskIntoConstraints = false
        homePill.isHidden = true
        homePill.addTarget(self, action: #selector(goHome), for: .touchUpInside)
        view.addSubview(homePill)
        var warn = look
        warn.title = prefs.videoBlockedTitle
        warn.baseBackgroundColor = UIColor(red: 0.55, green: 0.17, blue: 0.07, alpha: 0.85)
        videoPill.configuration = warn
        videoPill.translatesAutoresizingMaskIntoConstraints = false
        videoPill.isHidden = true
        videoPill.addTarget(self, action: #selector(openRefused), for: .touchUpInside)
        view.addSubview(videoPill)
        NSLayoutConstraint.activate([
            homePill.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            homePill.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            videoPill.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            videoPill.trailingAnchor.constraint(equalTo: homePill.leadingAnchor, constant: -10),
        ])
        urlWatch = web.observe(\.url, options: [.initial, .new]) { [weak self] w, _ in
            DispatchQueue.main.async {
                let site = Self.isWebsite(w.url)
                self?.homePill.isHidden = !site
                if !site { self?.videoPill.isHidden = true }
            }
        }
    }

    static func isWebsite(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return host != webApp.host
    }

    @objc private func goHome() { leave(to: Self.webApp) }

    /// The Video blocked button: the parent area (behind the PIN) at the list of refused hosts.
    @objc private func openRefused() { leave(to: URL(string: Self.webApp.absoluteString + "#/parent-blocked")!) }

    private func leave(to url: URL) {
        closePopups()
        homePill.isHidden = true
        videoPill.isHidden = true
        // The home screen reads the refused hosts from the state snapshot as it starts.
        installScripts()
        web.load(URLRequest(url: url))
    }

    /// A website's request that failed (from refusedScript). On a locked-down iPad, Screen Time refuses every host
    /// that is not allowed; such a host is kept for the parent area, and a video one shows the Video blocked button.
    private func noteRefused(_ address: String) {
        guard prefs.lockdownOn, let page = web.url, Self.isWebsite(page), let pageHost = page.host?.lowercased(),
              let u = URL(string: address), let host = u.host?.lowercased(), !allowed(u) else { return }
        let media = Self.isMedia(u)
        let key = pageHost + " " + host
        if var r = refused[key] {
            r["hits"] = (r["hits"] as? Int ?? 0) + 1
            if media { r["media"] = true }
            refused[key] = r
        } else if refused.count < 200 {
            refused[key] = ["page": pageHost, "host": host, "media": media, "hits": 1]
        }
        if media && !quietHosts.contains(where: { host == $0 || host.hasSuffix(".\($0)") }) { videoPill.isHidden = false }
    }

    /// A video playlist, segment or media file, by its address. Same list in the Android and Windows shells.
    static func isMedia(_ u: URL) -> Bool {
        let path = u.path.lowercased()
        if path.range(of: #"\.(m3u8|mpd|ts|m4s|mp4|m4v|m4a|mp3|aac|webm|ogg|ogv|cmfv|cmfa|vtt)$|/(hls|dash)/|\.ism/"#, options: .regularExpression) != nil { return true }
        return (u.query ?? "").lowercased().contains(".m3u8")
    }

    /// Runs in every frame of a website (never in Duckling's own page) and reports the address of each request that
    /// fails: Screen Time refuses a host that is not allowed without telling the app, so this is how the iPad learns of
    /// one. It reports addresses only, at most 20 times for each, and changes nothing on the page.
    static let refusedScript = """
    (function () {
      if (location.host === 'app.ducklingtablet.com' || window.__ducklingRefused) return;
      window.__ducklingRefused = true;
      var seen = {};
      function report(u) {
        try {
          var a = new URL(String(u), location.href);
          if ((a.protocol !== 'https:' && a.protocol !== 'http:') || a.host === location.host) return;
          var k = a.host + a.pathname.slice(-16);
          seen[k] = (seen[k] || 0) + 1;
          if (seen[k] > 20) return;
          window.webkit.messageHandlers.ducklingRefused.postMessage({ u: a.href.slice(0, 600) });
        } catch (e) {}
      }
      var f = window.fetch;
      if (f) window.fetch = function (input) {
        var u = typeof input === 'string' ? input : (input && input.url) || String(input);
        return f.apply(window, arguments).catch(function (e) { report(u); throw e; });
      };
      var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__ducklingUrl = u; return open.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () { var x = this; x.addEventListener('error', function () { report(x.__ducklingUrl); }); return send.apply(this, arguments); };
      window.addEventListener('error', function (e) { var t = e.target; if (t && t !== window && (t.currentSrc || t.src || t.href)) report(t.currentSrc || t.src || t.href); }, true);
    })();
    """

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
            "media": ["microphone": Self.access(.audio), "camera": Self.access(.video)],
            // The apps a parent picked on this iPad, by id with their minutes; names stay on the iPad (OtherApps.swift).
            "otherApps": OtherApps.shared.summary,
        ]
        if let h = prefs.pinHash { s["pinHash"] = h }
        if let d = AppViewController.pendingLocalBackground { s["localBackground"] = d }
        s["refused"] = Array(refused.values)
        return s
    }

    /// iOS's permission for Duckling to use the microphone or camera: on, off (declined, or switched off in Settings),
    /// blocked (a Screen Time restriction) or ask (iOS has not asked yet).
    static func access(_ media: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: media) {
        case .authorized: return "on"
        case .denied: return "off"
        case .restricted: return "blocked"
        case .notDetermined: return "ask"
        @unknown default: return "off"
        }
    }

    /// Clears what the given websites saved on this iPad (hosts as a JSON array): storage, offline files, service
    /// workers and cookies. Duckling's own pages and the apps keep their data. For a website that stopped loading or
    /// keeps showing an old version.
    private func clearWebsiteData(hostsJson: String) {
        guard let data = hostsJson.data(using: .utf8), let list = try? JSONSerialization.jsonObject(with: data) as? [String] else { return }
        let hosts = list.map { $0.lowercased() }
        let store = WKWebsiteDataStore.default(), types = WKWebsiteDataStore.allWebsiteDataTypes()
        store.fetchDataRecords(ofTypes: types) { records in
            // A record is named by its site (example.com); Duckling's own records (ducklingtablet.com, the app scheme) stay.
            let theirs = records.filter { r in
                let name = r.displayName.lowercased()
                return !name.contains("ducklingtablet") && hosts.contains { name == $0 || name.hasSuffix("." + $0) || $0.hasSuffix("." + name) }
            }
            store.removeData(ofTypes: types, for: theirs) {}
        }
    }

    /// Asks iOS for what it has not asked about yet; anything already declined can only be turned on in Settings, so
    /// Duckling's page in Settings opens.
    private func requestMedia() {
        Task {
            for media in [AVMediaType.audio, .video] where AVCaptureDevice.authorizationStatus(for: media) == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: media)
            }
            await MainActor.run {
                self.pushState()
                if [Self.access(.audio), Self.access(.video)].contains("off"), let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
            }
        }
    }

    private func stateJSON() -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: state()), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    /// The snapshot is part of the script that runs before the page on every load, and is pushed into a running page.
    /// Only Duckling's own page gets them: the snapshot holds the device token, and an allowed website loads in this
    /// same view. Websites get refusedScript instead.
    private func installScripts() {
        let ucc = web.configuration.userContentController
        ucc.removeAllUserScripts()
        let own = Self.webApp.host ?? "app.ducklingtablet.com"
        ucc.addUserScript(WKUserScript(source: "if (location.protocol === 'https:' && location.host === \(q(own))) {\nwindow.__ducklingState = \(stateJSON());\n\(shellScript)\n}", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(source: Self.refusedScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }

    private func pushState() {
        installScripts()
        js("window.__ducklingSetState && __ducklingSetState(\(stateJSON()))")
    }

    /// True while Duckling's own page is showing in the main view.
    private var onOwnPage: Bool { web.url?.scheme == "https" && web.url?.host?.lowercased() == Self.webApp.host }

    @objc private func stateChanged() { pushState() }

    @objc private func resumed() {
        Lockdown.shared.apply(on: prefs.lockdownOn, allowedHosts: prefs.allowedHosts)
        pushState()
        js("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()")
    }

    /// Runs code in Duckling's own page only: while a website is showing, nothing is sent to it (the state holds the
    /// device token).
    private func js(_ code: String) { DispatchQueue.main.async { if self.onOwnPage { self.web.evaluateJavaScript(code, completionHandler: nil) } } }
    private func q(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: [s]), let a = String(data: d, encoding: .utf8) else { return "''" }
        return String(a.dropFirst().dropLast())
    }

    // ---- Messages from the page ----------------------------------------------------------------------------------

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "ducklingRefused" {
            if let body = message.body as? [String: Any], let u = body["u"] as? String { noteRefused(u) }
            return
        }
        // Commands come only from Duckling's own page in the main view, never from a website or a frame in one.
        guard message.webView === web, message.frameInfo.isMainFrame, onOwnPage,
              message.frameInfo.securityOrigin.host.lowercased() == Self.webApp.host,
              let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
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
        case "requestMedia": requestMedia()
        case "clearWebsiteData": clearWebsiteData(hostsJson: str(0))
        case "tookLocalBackground": if AppViewController.pendingLocalBackground != nil { AppViewController.pendingLocalBackground = nil; installScripts() }
        case "openSettings":
            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
        case "chooseOtherApps": chooseOtherApps(spanish: str(0) == "es")
        case "setLanguage":
            prefs.language = str(0)
            homePill.configuration?.title = prefs.homeTitle
            videoPill.configuration?.title = prefs.videoBlockedTitle
        case "tookRefused": refused = [:]; installScripts()
        case "setQuietHosts":
            quietHosts = str(0).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        case "setLockdown":
            prefs.lockdownOn = (a.first as? Bool) ?? (str(0) == "true")
            Lockdown.shared.apply(on: prefs.lockdownOn, allowedHosts: prefs.allowedHosts)
            pushState()
        case "setAllowedHosts":
            prefs.allowedHosts = str(0).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
            Lockdown.shared.apply(on: prefs.lockdownOn, allowedHosts: prefs.allowedHosts)
        case "setSignInHosts":
            prefs.signInHosts = str(0).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
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
        case "signIn":
            guard str(0) == "apple", !str(1).isEmpty else {
                js("window.DucklingWeb && DucklingWeb.onSignIn && DucklingWeb.onSignIn('failed', '', '')")
                break
            }
            // The token goes to Duckling's own page only: js() runs only while it shows.
            appleSignIn.start(nonce: str(1), window: view.window) { [weak self] status, token, message in
                guard let self else { return }
                self.js("window.DucklingWeb && DucklingWeb.onSignIn && DucklingWeb.onSignIn(\(self.q(status)), \(self.q(token)), \(self.q(message)))")
            }
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
        // A background the app set for this tablet reaches the page in the state snapshot before onResume.
        vc.onClose = { [weak self] in
            guard let self else { return }
            if AppViewController.pendingLocalBackground != nil { self.pushState() }
            self.js("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()")
        }
        present(vc, animated: false)
    }

    /// The parent's other-apps screen (OtherAppsSheet). Every change goes straight to the lockdown and into the
    /// state the page reads, so the parent area and the server's list follow.
    private func chooseOtherApps(spanish: Bool) {
        guard presentedViewController == nil else { return }
        let apply = { [weak self] in
            guard let self else { return }
            Lockdown.shared.apply(on: self.prefs.lockdownOn, allowedHosts: self.prefs.allowedHosts)
            self.pushState()
        }
        let sheet = OtherAppsSheet(spanish: spanish, onChange: apply, onDone: { [weak self] in self?.dismiss(animated: true); apply(); self?.js("window.DucklingWeb && DucklingWeb.onOtherApps && DucklingWeb.onOtherApps()") })
        let host = UIHostingController(rootView: sheet)
        host.modalPresentationStyle = .formSheet
        present(host, animated: true)
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

    /// Safari's own user agent on this iPad, for the sign-in services (the system one names WebKit without Safari,
    /// which Google refuses with disallowed_useragent). Everything else sees the system agent.
    static let browserAgent: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(v.majorVersion).\(v.minorVersion) Safari/605.1.15"
    }()

    private func isSignIn(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return prefs.signInHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        guard allowed(url) else { return decisionHandler(.cancel) }
        // A standard browser while signing in, Duckling's own view again on the way back to the site.
        // iOS 27 reads back an unset agent as "" rather than nil, so the two are compared as "no agent"; compared as
        // they were, "" never equalled nil, every navigation was cancelled and restarted without end, and the home
        // screen stayed blank. A request is restarted at most once, so no reading of the agent can loop again.
        if action.targetFrame?.isMainFrame != false {
            let agent: String? = isSignIn(url) ? Self.browserAgent : nil
            let current = webView.customUserAgent.flatMap { $0.isEmpty ? nil : $0 }
            if current != agent, restartedURL != url {
                webView.customUserAgent = agent
                restartedURL = url
                // The agent applies to requests made after it is set; this one is restarted with it.
                decisionHandler(.cancel)
                webView.load(action.request)
                return
            }
            restartedURL = nil
        }
        decisionHandler(.allow)
    }

    /// A website's new window (its "Sign in with Google" window) opens over it as a real window, so the sign-in can
    /// report back to the page that opened it and close itself. Opened in place, as before, the report had nowhere to
    /// go and the sign-in ended on a blank page. The same host rules apply inside it; the Home pill closes it.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = action.request.url
        if let url = url, !url.absoluteString.isEmpty, !allowed(url) { return nil }
        let popup = WKWebView(frame: view.bounds, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        if let url = url, isSignIn(url) { popup.customUserAgent = Self.browserAgent }
        popup.scrollView.contentInsetAdjustmentBehavior = .never
        view.insertSubview(popup, belowSubview: homePill)
        pin(popup, to: view)
        popups.append(popup)
        return popup
    }

    func webViewDidClose(_ webView: WKWebView) { close(popup: webView) }

    // alert(), confirm() and prompt() (WebDialogs.swift); WKWebView shows none of them by itself.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        WebDialogs.alert(message, from: self, done: completionHandler)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        WebDialogs.confirm(message, from: self, done: completionHandler)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        WebDialogs.prompt(prompt, defaultText: defaultText, from: self, done: completionHandler)
    }

    /// Makes `child` fill `parent` at every size and rotation.
    private func pin(_ child: UIView, to parent: UIView) {
        child.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            child.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
            child.topAnchor.constraint(equalTo: parent.topAnchor),
            child.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
        ])
    }

    private func close(popup: WKWebView) {
        guard let i = popups.firstIndex(where: { $0 === popup }) else { return }
        popups.remove(at: i)
        popup.stopLoading()
        popup.removeFromSuperview()
    }

    private func closePopups() { for p in popups { close(popup: p) } }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

/// WKUserContentController holds its handlers strongly; this breaks the cycle with the view controller.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) { target?.userContentController(ucc, didReceive: message) }
}
