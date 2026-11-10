import Foundation
import CryptoKit
import ZIPFoundation

/// Installed app packages live in Application Support/apps/<id>/ and are served to the app runner by LocalServer.
/// A package is unpacked only after its SHA-256 matches the catalog and its Ed25519 signature verifies against the
/// public key compiled in here (the same key as the Android shell's Signing.kt).
final class Packages {
    static let shared = Packages()
    static let publicKeyB64 = "WjahKRLoQJBt/V1D48hazYaoVJaWkON81N0FeIMLols="

    struct InstallError: LocalizedError { let message: String; var errorDescription: String? { message } }

    let root: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let u = base.appendingPathComponent("apps", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        var v = URLResourceValues(); v.isExcludedFromBackup = true
        var m = u; try? m.setResourceValues(v)
        return u
    }()

    func dir(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
    func exists(_ id: String) -> Bool { FileManager.default.fileExists(atPath: dir(id).appendingPathComponent("index.html").path) }

    static func sha256Hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func verify(_ data: Data, signatureB64: String) -> Bool {
        guard let k = Data(base64Encoded: publicKeyB64), let s = Data(base64Encoded: signatureB64),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: k) else { return false }
        return key.isValidSignature(s, for: data)
    }

    /// Downloads, verifies and unpacks. Throws InstallError with a message fit for the child's screen.
    func install(id: String, url: String, sha256: String, signature: String) async throws {
        guard id.range(of: "^[a-z0-9][a-z0-9-]{1,40}$", options: .regularExpression) != nil else { throw InstallError(message: "Bad app id.") }
        guard let u = URL(string: url), u.scheme == "https" else { throw InstallError(message: "Packages come only over HTTPS.") }
        let (data, response) = try await URLSession.shared.data(from: u)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw InstallError(message: "Download failed.") }
        guard data.count < 200 * 1024 * 1024 else { throw InstallError(message: "Package is too large.") }
        guard Self.sha256Hex(data) == sha256.lowercased() else { throw InstallError(message: "The download did not match. Try again.") }
        guard Self.verify(data, signatureB64: signature) else { throw InstallError(message: "This package is not signed by Duckling.") }

        let fm = FileManager.default
        let zip = root.appendingPathComponent("\(id).zip")
        let staging = root.appendingPathComponent("\(id).new", isDirectory: true)
        try? fm.removeItem(at: staging); try? fm.removeItem(at: zip)
        try data.write(to: zip)
        defer { try? fm.removeItem(at: zip) }
        // ZIPFoundation refuses entries that would land outside the destination ("../" or absolute names).
        do { try fm.unzipItem(at: zip, to: staging) } catch { try? fm.removeItem(at: staging); throw InstallError(message: "The package could not be opened.") }
        guard fm.fileExists(atPath: staging.appendingPathComponent("index.html").path) else { try? fm.removeItem(at: staging); throw InstallError(message: "Package has no index.html.") }
        try? fm.removeItem(at: dir(id))
        do { try fm.moveItem(at: staging, to: dir(id)) } catch { throw InstallError(message: "Could not finish the install.") }
    }

    func uninstall(_ id: String) { try? FileManager.default.removeItem(at: dir(id)) }
    func removeAll() { try? FileManager.default.removeItem(at: root); try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
}
