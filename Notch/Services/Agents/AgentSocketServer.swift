import Darwin
import Foundation

/// Listens on `~/.notch/agents.sock` for line-delimited `HookEnvelope` JSON from
/// the hook/notify clients. Almost all traffic is fire-and-forget: the client
/// connects, writes one line, and closes. The one exception is a blocking
/// `PermissionRequest` hook, which keeps its connection open until `respond` is
/// called with the user's decision (or the pending window lapses).
///
/// All socket I/O runs on a private queue; decoded envelopes are handed to the
/// handler, which hops to the main actor. Push-based via `DispatchSource` — no
/// polling. Technique reference: devmegablaster/Notch-Pilot (MIT).
final class AgentSocketServer: @unchecked Sendable {

    private let queue = DispatchQueue(label: "com.aquitano.notch.agentsocket")
    /// Per-client reads run here so one slow/hung peer can't stall accepting or
    /// delivering the others.
    private let ioQueue = DispatchQueue(label: "com.aquitano.notch.agentsocket.io", attributes: .concurrent)
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var handler: (@Sendable (HookEnvelope, pid_t) -> Void)?
    /// Open connections of blocked PermissionRequest hooks, by request id
    /// (guarded by `queue`). Closed unanswered after `pendingWindow` — the hook
    /// client treats that as "ask" and Claude falls back to its terminal prompt.
    private var pendingReplies: [String: Int32] = [:]
    private static let pendingWindow: TimeInterval = 130

    /// Bind, listen, and start accepting. `onEnvelope` is invoked on the I/O
    /// queue (its closure is responsible for hopping to the main actor).
    func start(onEnvelope: @escaping @Sendable (HookEnvelope, pid_t) -> Void) {
        queue.async { [weak self] in self?.bind(onEnvelope) }
    }

    func stop() {
        queue.async { [weak self] in self?.teardown() }
    }

    // MARK: - Setup

    private func bind(_ onEnvelope: @escaping @Sendable (HookEnvelope, pid_t) -> Void) {
        let url = AgentSocket.url
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        let path = url.path
        unlink(path) // clear a stale socket from a previous run

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            Log.agents.error("agent socket: socket() failed errno=\(errno)")
            return
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = path.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            Log.agents.error("agent socket: path too long")
            close(fd)
            return
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { dst in
            dst.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dstC in
                pathBytes.withUnsafeBufferPointer { src in
                    dstC.update(from: src.baseAddress!, count: pathBytes.count)
                }
            }
        }

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, len)
            }
        }
        guard bound == 0 else {
            Log.agents.error("agent socket: bind() failed errno=\(errno)")
            close(fd)
            return
        }

        chmod(path, 0o600)

        // Non-blocking listen fd so the accept loop drains all pending peers and
        // returns instead of blocking the queue once they're consumed.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        guard listen(fd, 8) == 0 else {
            Log.agents.error("agent socket: listen() failed errno=\(errno)")
            close(fd)
            return
        }

        listenFD = fd
        handler = onEnvelope

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptConnections() }
        source.setCancelHandler { close(fd) }
        acceptSource = source
        source.resume()
        Log.agents.info("agent socket listening at \(path)")
    }

    private func teardown() {
        acceptSource?.cancel()
        acceptSource = nil
        listenFD = -1
        handler = nil
        for fd in pendingReplies.values { close(fd) }
        pendingReplies = [:]
        unlink(AgentSocket.url.path)
    }

    // MARK: - Permission replies

    /// Answer a blocked PermissionRequest hook. `decision` is "allow" / "deny" /
    /// "ask". Completion (on main) reports whether the reply was delivered —
    /// false when the hook already timed out and Claude is showing its own prompt.
    func respond(requestId: String, decision: String, completion: @escaping @Sendable (Bool) -> Void = { _ in }) {
        queue.async { [weak self] in
            guard let self, let fd = self.pendingReplies.removeValue(forKey: requestId) else {
                DispatchQueue.main.async { completion(false) }
                return
            }
            var line = Data("{\"decision\":\"\(decision)\"}".utf8)
            line.append(0x0A)
            let written = line.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            close(fd)
            DispatchQueue.main.async { completion(written == line.count) }
        }
    }

    private func registerPendingReply(_ requestId: String, fd: Int32) {
        queue.async { [weak self] in
            guard let self else { close(fd); return }
            // A duplicate request id would orphan the previous fd; close it first.
            if let stale = self.pendingReplies.removeValue(forKey: requestId) { close(stale) }
            self.pendingReplies[requestId] = fd
            self.queue.asyncAfter(deadline: .now() + Self.pendingWindow) { [weak self] in
                guard let self, let stale = self.pendingReplies.removeValue(forKey: requestId) else { return }
                close(stale)
            }
        }
    }

    // MARK: - Accept / read

    private func acceptConnections() {
        while true {
            let client = accept(listenFD, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                break // EAGAIN/EWOULDBLOCK: drained (other errors: the source re-fires)
            }
            // Snapshot the handler on the accept queue, then hand the blocking
            // read off to a concurrent queue so peers don't serialize.
            let handler = self.handler
            ioQueue.async { [weak self] in
                guard let self else { close(client); return }
                self.handleClient(client, handler: handler)
            }
        }
    }

    private func handleClient(_ client: Int32, handler: (@Sendable (HookEnvelope, pid_t) -> Void)?) {
        var keepOpen = false
        defer { if !keepOpen { close(client) } }

        // Read with a short timeout so a hung peer can't wedge its io slot.
        let flags = fcntl(client, F_GETFL, 0)
        _ = fcntl(client, F_SETFL, flags & ~O_NONBLOCK)
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        let peer = peerPID(of: client)
        let data = readAll(client)

        for line in data.split(separator: 0x0A) where !line.isEmpty {
            guard let envelope = try? JSONDecoder().decode(HookEnvelope.self, from: Data(line)) else {
                continue
            }
            // A blocking permission hook stays connected awaiting the decision.
            if envelope.hook == "PermissionRequest", let requestId = envelope.requestId {
                registerPendingReply(requestId, fd: client)
                keepOpen = true
            }
            let pid = envelope.pid.map { pid_t($0) } ?? peer
            handler?(envelope, pid)
        }
    }

    private func readAll(_ fd: Int32) -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            guard n > 0 else { break } // 0 = EOF, <0 = error/timeout
            data.append(contentsOf: buffer[0..<n])
            // A trailing newline ends the batch: every client writes whole lines,
            // and returning here (instead of waiting for EOF) both avoids the 2s
            // timeout and leaves a blocking permission client's connection usable.
            if data.last == 0x0A { break }
            if data.count > 1 << 20 { break } // 1 MB sanity cap
        }
        return data
    }

    private func peerPID(of fd: Int32) -> pid_t {
        var pid: pid_t = 0
        var len = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0 else { return 0 }
        return pid
    }
}
