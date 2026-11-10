import Foundation
import Network

/// Serves installed app packages to the app runner at http://127.0.0.1:47900/apps/<id>/..., on the loopback interface
/// only. Apps need a real web origin: localStorage, IndexedDB, fetch of their own files and the microphone all work
/// there, where file:// URLs would not. The port is fixed so the origin, and with it every app's saved progress,
/// stays the same across launches.
final class LocalServer {
    static let shared = LocalServer()
    static let port: UInt16 = 47900
    static var origin: String { "http://127.0.0.1:\(port)" }

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.ducklingtablet.localserver")

    func start() {
        queue.async { self.startLocked() }
    }

    /// iOS can stop the listener while the app is in the background; the shell calls this whenever it comes back.
    func ensureRunning() {
        queue.async {
            if let l = self.listener, case .ready = l.state { return }
            self.listener?.cancel(); self.listener = nil
            self.startLocked()
        }
    }

    private func startLocked() {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: NWEndpoint.Port(rawValue: Self.port)!)
        guard let l = try? NWListener(using: params) else { return }
        l.newConnectionHandler = { [weak self] c in self?.serve(c) }
        l.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.queue.asyncAfter(deadline: .now() + 1) { self?.listener = nil; self?.startLocked() } }
        }
        l.start(queue: queue)
        listener = l
    }

    private func serve(_ c: NWConnection) {
        c.start(queue: queue)
        receiveHead(c, buffer: Data())
    }

    private func receiveHead(_ c: NWConnection, buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self else { c.cancel(); return }
            var buf = buffer
            if let data { buf.append(data) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(c, head: String(decoding: buf[..<end.lowerBound], as: UTF8.self))
            } else if done || error != nil || buf.count > 65536 {
                c.cancel()
            } else {
                self.receiveHead(c, buffer: buf)
            }
        }
    }

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp", "wasm": "application/wasm", "mp3": "audio/mpeg",
        "ogg": "audio/ogg", "wav": "audio/wav", "m4a": "audio/mp4", "mp4": "video/mp4", "glb": "model/gltf-binary",
        "gltf": "model/gltf+json", "bin": "application/octet-stream", "txt": "text/plain; charset=utf-8", "woff2": "font/woff2",
        "woff": "font/woff", "ttf": "font/ttf", "zip": "application/zip", "tar": "application/x-tar", "gz": "application/gzip",
    ]

    private func respond(_ c: NWConnection, head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count >= 2 else { return finish(c, status: "400 Bad Request") }
        let method = String(parts[0])
        guard method == "GET" || method == "HEAD" else { return finish(c, status: "405 Method Not Allowed") }
        let rawPath = String(parts[1]).components(separatedBy: "?")[0]
        guard let path = rawPath.removingPercentEncoding, path.hasPrefix("/apps/"), !path.contains(".."), !path.contains("\\") else { return finish(c, status: "404 Not Found") }
        let root = Packages.shared.root.standardizedFileURL
        var file = root.appendingPathComponent(String(path.dropFirst("/apps/".count))).standardizedFileURL
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), isDir.boolValue { file = file.appendingPathComponent("index.html") }
        guard file.path.hasPrefix(root.path + "/"), let handle = try? FileHandle(forReadingFrom: file),
              let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value else { return finish(c, status: "404 Not Found") }

        var start: Int64 = 0, end: Int64 = max(0, size - 1), partial = false
        if let range = lines.first(where: { $0.lowercased().hasPrefix("range:") }), let spec = range.split(separator: "=").last {
            let ends = spec.split(separator: "-", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
            if ends.count == 2 {
                if let s = Int64(ends[0]) { start = s; if let e = Int64(ends[1]) { end = min(e, size - 1) } }
                else if let n = Int64(ends[1]) { start = max(0, size - n) }
                partial = start <= end && start < size
                if !partial { try? handle.close(); return finish(c, status: "416 Range Not Satisfiable", extra: "Content-Range: bytes */\(size)\r\n") }
            }
        }
        let length = size == 0 ? 0 : end - start + 1
        let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        var header = "HTTP/1.1 \(partial ? "206 Partial Content" : "200 OK")\r\nContent-Type: \(type)\r\nContent-Length: \(length)\r\n"
        header += "Accept-Ranges: bytes\r\nCache-Control: no-cache\r\nConnection: close\r\n"
        if partial { header += "Content-Range: bytes \(start)-\(end)/\(size)\r\n" }
        header += "\r\n"
        c.send(content: Data(header.utf8), completion: .contentProcessed { _ in })
        if method == "HEAD" || length == 0 { try? handle.close(); return c.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() }) }
        try? handle.seek(toOffset: UInt64(start))
        sendBody(c, handle: handle, remaining: length)
    }

    private func sendBody(_ c: NWConnection, handle: FileHandle, remaining: Int64) {
        if remaining <= 0 {
            try? handle.close()
            c.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
            return
        }
        let chunk = (try? handle.read(upToCount: Int(min(remaining, 256 * 1024)))) ?? Data()
        if chunk.isEmpty { try? handle.close(); c.cancel(); return }
        c.send(content: chunk, completion: .contentProcessed { [weak self] error in
            if error != nil { try? handle.close(); c.cancel(); return }
            self?.sendBody(c, handle: handle, remaining: remaining - Int64(chunk.count))
        })
    }

    private func finish(_ c: NWConnection, status: String, extra: String = "") {
        let head = "HTTP/1.1 \(status)\r\nContent-Length: 0\r\nConnection: close\r\n\(extra)\r\n"
        c.send(content: Data(head.utf8), contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
    }
}
