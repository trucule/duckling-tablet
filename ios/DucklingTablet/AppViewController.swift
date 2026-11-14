import UIKit
import WebKit
import AVFoundation

/// Runs one installed app full screen from its files (AppSchemeHandler), with window.DucklingApp (what duckling-compat.js inside
/// the package reads) and a Home pill at the top right. Apps reach only their own files, the API and the CDN, and get
/// the microphone or camera only when their manifest asked for it.
final class AppViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, AVSpeechSynthesizerDelegate {
    private let appId: String
    private var web: WKWebView!
    private let prefs = Prefs.shared
    private let speech = AVSpeechSynthesizer()
    private var spoken: [ObjectIdentifier: String] = [:]

    /// Called once the app is closed, so the home screen checks in for what the app saved (portrait, background, stars).
    var onClose: (() -> Void)?

    init(appId: String) { self.appId = appId; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("not used") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    private func bridgeScript() -> String {
        func lit(_ s: String) -> String {
            guard let d = try? JSONSerialization.data(withJSONObject: [s]), let a = String(data: d, encoding: .utf8) else { return "''" }
            return String(a.dropFirst().dropLast())
        }
        return """
        window.DucklingApp = {
          appId: function () { return \(lit(appId)); },
          deviceToken: function () { return \(lit(prefs.deviceToken)); },
          apiUrl: function () { return 'https://api.ducklingtablet.com'; },
          childId: function () { return \(lit(prefs.childId)); },
          childName: function () { return \(lit(prefs.childName)); },
          voice: function () { return \(lit(prefs.narratorVoice)); },
          levels: function () { return \(lit(prefs.childLevels)); },
          speak: function (id, text, rate) { window.webkit.messageHandlers.duckling.postMessage({ cmd: 'speak', args: [id, text, rate] }); },
          stopSpeaking: function () { window.webkit.messageHandlers.duckling.postMessage({ cmd: 'stopSpeaking', args: [] }); }
        };
        """
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.add(WeakHandler(self), name: "duckling")
        config.userContentController.addUserScript(WKUserScript(source: bridgeScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.backgroundColor = .black
        view = web
        speech.delegate = self
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try? AVAudioSession.sharedInstance().setActive(true)

        var look = UIButton.Configuration.filled()
        look.title = "⌂ Home"
        look.baseBackgroundColor = UIColor(white: 0.1, alpha: 0.55)
        look.baseForegroundColor = .white
        look.cornerStyle = .capsule
        look.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18)
        look.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in var b = a; b.font = .systemFont(ofSize: 18, weight: .bold); return b }
        let home = UIButton(configuration: look)
        home.translatesAutoresizingMaskIntoConstraints = false
        home.addTarget(self, action: #selector(goHome), for: .touchUpInside)
        view.addSubview(home)
        NSLayoutConstraint.activate([
            home.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            home.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
        ])

        if let u = URL(string: "\(AppSchemeHandler.origin)/apps/\(appId)/index.html") { web.load(URLRequest(url: u)) }
    }

    @objc private func goHome() {
        speech.stopSpeaking(at: .immediate)
        web.stopLoading()
        let done = onClose
        dismiss(animated: false) { done?() }
    }

    // ---- The tablet's own voice for lines the narrator cannot play (duckling-compat.js calls speak) -------------

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let a = body["args"] as? [Any] ?? []
        if cmd == "speak", a.count >= 3, let id = a[0] as? String, let text = a[1] as? String {
            let u = AVSpeechUtterance(string: text)
            let rate = (a[2] as? Double) ?? 1
            u.rate = Float(min(max(Double(AVSpeechUtteranceDefaultSpeechRate) * rate, Double(AVSpeechUtteranceMinimumSpeechRate)), Double(AVSpeechUtteranceMaximumSpeechRate)))
            u.voice = AVSpeechSynthesisVoice(language: "en-US")
            spoken[ObjectIdentifier(u)] = id
            speech.speak(u)
        } else if cmd == "stopSpeaking" {
            speech.stopSpeaking(at: .immediate)
        }
    }

    private func report(_ kind: String, _ u: AVSpeechUtterance) {
        guard let id = spoken[ObjectIdentifier(u)], id.range(of: "^v[0-9]+$", options: .regularExpression) != nil else { return }
        if kind != "start" { spoken.removeValue(forKey: ObjectIdentifier(u)) }
        web.evaluateJavaScript("window.__ducklingVoice && __ducklingVoice.\(kind)('\(id)')", completionHandler: nil)
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) { report("start", u) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { report("end", u) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { report("error", u) }

    // ---- What an app may reach ------------------------------------------------------------------------------------

    private static let reachable: Set<String> = ["api.ducklingtablet.com", "duckling.nyc3.cdn.digitaloceanspaces.com"]

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let local = url.scheme == AppSchemeHandler.scheme && url.host == AppSchemeHandler.host && url.path.hasPrefix("/apps/\(appId)/")
        let ok = local || (action.targetFrame?.isMainFrame == false && Self.reachable.contains(url.host ?? "")) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
        decisionHandler(ok ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let perms = Set(prefs.permissions[appId] ?? [])
        let fromApp = origin.protocol == AppSchemeHandler.scheme && origin.host == AppSchemeHandler.host
        let ok: Bool
        switch type {
        case .microphone: ok = perms.contains("microphone")
        case .camera: ok = perms.contains("camera")
        case .cameraAndMicrophone: ok = perms.contains("camera") && perms.contains("microphone")
        @unknown default: ok = false
        }
        decisionHandler(fromApp && ok ? .grant : .deny)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // A load that fails says why on screen, under the Home pill, where a blank page would say nothing.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure(error) }

    private func showFailure(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let html = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="margin:0;background:#1e2a33;color:#fff;font:20px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">
        <div style="max-width:560px;padding:24px"><p style="font-size:28px;font-weight:700">This app did not open.</p>
        <p>Tap Home and try again. If it happens again, a parent can send this line to support:</p>
        <p style="font:15px ui-monospace,monospace;opacity:.8">\(esc(appId)) \(esc(e.domain)) \(e.code) \(esc(e.localizedDescription))</p></div></body>
        """
        web.loadHTMLString(html, baseURL: nil)
    }
}
