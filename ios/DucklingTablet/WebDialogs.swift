import UIKit
import WebKit

/// alert(), confirm() and prompt() for the web views. WKWebView shows none of them on its own: without these, an
/// alert() vanished and confirm() answered false at once, so "Remove Duckling from this device" and "Clear saved
/// website data" in the parent area did nothing on the iPad. The buttons follow the tablet's language.
enum WebDialogs {
    private static var spanish: Bool { Prefs.shared.language == "es" }
    private static var ok: String { spanish ? "Aceptar" : "OK" }
    private static var cancel: String { spanish ? "Cancelar" : "Cancel" }

    /// The controller to present from: the given one, or what it is already presenting.
    private static func top(_ vc: UIViewController) -> UIViewController {
        var c = vc
        while let p = c.presentedViewController, !p.isBeingDismissed { c = p }
        return c
    }

    static func alert(_ message: String, from vc: UIViewController, done: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: ok, style: .default) { _ in done() })
        top(vc).present(a, animated: true)
    }

    static func confirm(_ message: String, from vc: UIViewController, done: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in done(false) })
        a.addAction(UIAlertAction(title: ok, style: .default) { _ in done(true) })
        top(vc).present(a, animated: true)
    }

    static func prompt(_ message: String, defaultText: String?, from vc: UIViewController, done: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in done(nil) })
        a.addAction(UIAlertAction(title: ok, style: .default) { [weak a] _ in done(a?.textFields?.first?.text ?? "") })
        top(vc).present(a, animated: true)
    }
}
