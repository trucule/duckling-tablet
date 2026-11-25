import Foundation
import Security

/// What the shell keeps between launches. The device token is the tablet's credential, so it lives in the Keychain;
/// everything else is ordinary settings.
final class Prefs {
    static let shared = Prefs()
    private let d = UserDefaults.standard

    /// The Keychain outlives the app: a token from before an uninstall came back with the reinstalled app, which then
    /// started as a tablet the family had already removed (an empty home screen, and installs answered "released").
    /// Settings are deleted with the app, so a missing marker means this is a new install: forget the old token.
    private init() {
        if !d.bool(forKey: "installedBefore") {
            Keychain.delete("deviceToken")
            d.set(true, forKey: "installedBefore")
        }
    }

    var deviceToken: String {
        get { Keychain.get("deviceToken") ?? "" }
        set { if newValue.isEmpty { Keychain.delete("deviceToken") } else { Keychain.set("deviceToken", newValue) } }
    }
    /// SHA-256 hex of "duckling:<pin>", the same form the Android shell and the server's device config use.
    var pinHash: String? {
        get { d.string(forKey: "pinHash") }
        set { d.set(newValue, forKey: "pinHash") }
    }
    var installed: [String: String] {
        get { d.dictionary(forKey: "installed") as? [String: String] ?? [:] }
        set { d.set(newValue, forKey: "installed") }
    }
    /// Permissions each installed app asked for in its manifest (microphone, camera).
    var permissions: [String: [String]] {
        get { d.dictionary(forKey: "permissions") as? [String: [String]] ?? [:] }
        set { d.set(newValue, forKey: "permissions") }
    }
    /// The tablet's language, 'en' or 'es', as the home screen last said (setLanguage). Until it has, the iPad's own
    /// language when that is Spanish.
    var language: String {
        get { d.string(forKey: "language") ?? (Locale.preferredLanguages.first?.hasPrefix("es") == true ? "es" : "en") }
        set { d.set(newValue == "es" ? "es" : "en", forKey: "language") }
    }
    /// The Home pill's words in the tablet's language.
    var homeTitle: String { language == "es" ? "\u{2302} Inicio" : "\u{2302} Home" }
    /// The Video blocked button's words, beside Home while a website's video was refused.
    var videoBlockedTitle: String { language == "es" ? "Video bloqueado" : "Video blocked" }
    var childId: String { get { d.string(forKey: "childId") ?? "" } set { d.set(newValue, forKey: "childId") } }
    var childName: String { get { d.string(forKey: "childName") ?? "" } set { d.set(newValue, forKey: "childName") } }
    var childLevels: String { get { d.string(forKey: "childLevels") ?? "{}" } set { d.set(newValue, forKey: "childLevels") } }
    var narratorVoice: String { get { d.string(forKey: "narratorVoice") ?? "en-US-AnaNeural" } set { d.set(newValue, forKey: "narratorVoice") } }
    var appAccountToken: String { get { d.string(forKey: "appAccountToken") ?? "" } set { d.set(newValue, forKey: "appAccountToken") } }
    var lockdownOn: Bool { get { d.bool(forKey: "lockdownOn") } set { d.set(newValue, forKey: "lockdownOn") } }
    var allowedHosts: [String] { get { d.stringArray(forKey: "allowedHosts") ?? [] } set { d.set(newValue, forKey: "allowedHosts") } }
    /// Sign-in services shown a standard browser user agent (MainViewController.browserAgent).
    var signInHosts: [String] { get { d.stringArray(forKey: "signInHosts") ?? [] } set { d.set(newValue, forKey: "signInHosts") } }

    func clearAll() {
        deviceToken = ""
        for k in ["pinHash", "installed", "permissions", "childId", "childName", "childLevels", "narratorVoice", "appAccountToken", "lockdownOn", "allowedHosts", "signInHosts"] { d.removeObject(forKey: k) }
    }
}

enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.ducklingtablet.app", kSecAttrAccount as String: key]
    }
    static func get(_ key: String) -> String? {
        var q = query(key); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func set(_ key: String, _ value: String) {
        delete(key)
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
    static func delete(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}
