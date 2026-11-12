import Foundation
import WebKit

/// Serves installed app packages to the app runner at duckling-app://local/apps/<id>/..., straight from the files
/// in Application Support with no network in between. Screen Time's web filter, which the lockdown turns on, judges
/// every http and https load, and it blocked the loopback server the apps used to come from (a blank white page with
/// the lockdown on); loads through a URL scheme handler never reach the filter. The origin stays the same across
/// launches, so localStorage and IndexedDB keep each app's progress. Range requests are answered for audio and video.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "duckling-app"
    static let host = "local"
    static var origin: String { "\(scheme)://\(host)" }

    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()

    private static let types: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "json": "application/json",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "svg": "image/svg+xml",
        "webp": "image/webp", "wasm": "application/wasm", "mp3": "audio/mpeg", "ogg": "audio/ogg", "wav": "audio/wav",
        "m4a": "audio/mp4", "mp4": "video/mp4", "glb": "model/gltf-binary", "gltf": "model/gltf+json",
        "bin": "application/octet-stream", "txt": "text/plain", "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf",
        "zip": "application/zip", "tar": "application/x-tar", "gz": "application/gzip",
    ]
    private static let textTypes: Set<String> = ["text/html", "text/javascript", "text/css", "application/json", "image/svg+xml", "text/plain"]

    /// The file a request names, or nil when it is outside the installed packages.
    static func file(for url: URL) -> URL? {
        guard url.scheme == scheme, url.host == host else { return nil }
        let path = url.path // already percent-decoded
        guard path.hasPrefix("/apps/"), !path.contains(".."), !path.contains("\\") else { return nil }
        let root = Packages.shared.root.standardizedFileURL
        var file = root.appendingPathComponent(String(path.dropFirst("/apps/".count))).standardizedFileURL
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), isDir.boolValue { file = file.appendingPathComponent("index.html") }
        guard file.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: file.path) else { return nil }
        return file
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); stopped.remove(id); lock.unlock()
        guard let url = task.request.url, let file = Self.file(for: url),
              let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value,
              let handle = try? FileHandle(forReadingFrom: file) else {
            return respond(task, url: task.request.url, status: 404, headers: [:], body: Data())
        }
        defer { try? handle.close() }

        var start: Int64 = 0, end: Int64 = max(0, size - 1), partial = false
        if let spec = task.request.value(forHTTPHeaderField: "Range")?.split(separator: "=").last {
            let ends = spec.split(separator: "-", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
            if ends.count == 2 {
                if let s = Int64(ends[0]) { start = s; if let e = Int64(ends[1]) { end = min(e, size - 1) } }
                else if let n = Int64(ends[1]) { start = max(0, size - n) }
                partial = start <= end && start < size
                if !partial { return respond(task, url: url, status: 416, headers: ["Content-Range": "bytes */\(size)"], body: Data()) }
            }
        }
        let length = size == 0 ? 0 : end - start + 1
        var type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        if Self.textTypes.contains(type) { type += "; charset=utf-8" }
        var headers = ["Content-Type": type, "Content-Length": "\(length)", "Accept-Ranges": "bytes", "Cache-Control": "no-cache"]
        if partial { headers["Content-Range"] = "bytes \(start)-\(end)/\(size)" }
        guard let response = HTTPURLResponse(url: url, statusCode: partial ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        guard live(id) else { return }
        task.didReceive(response)
        try? handle.seek(toOffset: UInt64(start))
        var remaining = length
        while remaining > 0 {
            let chunk = (try? handle.read(upToCount: Int(min(remaining, 1024 * 1024)))) ?? Data()
            if chunk.isEmpty { break }
            guard live(id) else { return }
            task.didReceive(chunk)
            remaining -= Int64(chunk.count)
        }
        guard live(id) else { return }
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    private func live(_ id: ObjectIdentifier) -> Bool { lock.lock(); defer { lock.unlock() }; return !stopped.contains(id) }

    private func respond(_ task: WKURLSchemeTask, url: URL?, status: Int, headers: [String: String], body: Data) {
        guard live(ObjectIdentifier(task)), let url, let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers.merging(["Content-Length": "\(body.count)"]) { a, _ in a }) else { return }
        task.didReceive(r)
        if !body.isEmpty { task.didReceive(body) }
        task.didFinish()
    }
}
