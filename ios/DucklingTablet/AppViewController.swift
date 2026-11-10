import UIKit
import WebKit
import AVFoundation

/// Runs one installed app full screen from the local server, with window.DucklingApp (what duckling-compat.js inside
/// the package reads) and a Home pill at the top right. Apps reach only their own files, the API and the CDN, and get
/// the microphone or camera only when their manifest asked for it.
final class AppViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, AVSpeechSynthesizerDelegate {
    private let appId: String
    private var web: WKWebView!
    private let prefs = Prefs.shared
    private let speech = AVSpeechSynthesizer()
    private var spoken: [ObjectIdentifier: String] = [:]

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

        LocalServer.shared.ensureRunning()
        if let u = URL(string: "\(LocalServer.origin)/apps/\(appId)/index.html") { web.load(URLRequest(url: u)) }
    }

    @objc private func goHome() {
        speech.stopSpeaking(at: .immediate)
        web.stopLoading()
        dismiss(animated: false)
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
        let local = url.host == "127.0.0.1" && url.port == Int(LocalServer.port) && url.path.hasPrefix("/apps/\(appId)/")
        let ok = local || (action.targetFrame?.isMainFrame == false && Self.reachable.contains(url.host ?? "")) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
        decisionHandler(ok ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let perms = Set(prefs.permissions[appId] ?? [])
        let fromApp = origin.host == "127.0.0.1" && origin.port == Int(LocalServer.port)
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
}
