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
    /// Bound client concurrency so malformed local peers cannot consume the entire
    /// cooperative thread pool. Each read also has one total deadline below.
    private let ioQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "com.aquitano.notch.agentsocket.io"
        queue.qualityOfService = .utility
        queue.maxConcurrentOperationCount = 16
        return queue
    }()
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    /// Invalidates reads/timeouts queued by an earlier stop/start cycle.
    private var generation = 0
    /// True only after this server successfully bound the filesystem node. A
    /// second app instance that detects an existing live listener must never
    /// unlink that listener's socket when it later tears down.
    private var ownsSocket = false
    private var handler: (@Sendable (HookEnvelope, pid_t) -> Void)?
    private var permissionTimeoutHandler: (@Sendable (String) -> Void)?
    /// Open connections of blocked PermissionRequest hooks, by request id
    /// (guarded by `queue`). Closed unanswered after `pendingWindow` — the hook
    /// client treats that as "ask" and Claude falls back to its terminal prompt.
    private var pendingReplies: [String: Int32] = [:]
    private static let pendingWindow: TimeInterval = 130

    /// Bind, listen, and start accepting. `onEnvelope` is invoked on the I/O
    /// queue (its closure is responsible for hopping to the main actor).
    func start(
        onEnvelope: @escaping @Sendable (HookEnvelope, pid_t) -> Void,
        onPermissionTimeout: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        queue.async { [weak self] in self?.bind(onEnvelope, onPermissionTimeout: onPermissionTimeout) }
    }

    func stop() {
        queue.async { [weak self] in self?.teardown() }
    }

    // MARK: - Setup

    private func bind(
        _ onEnvelope: @escaping @Sendable (HookEnvelope, pid_t) -> Void,
        onPermissionTimeout: @escaping @Sendable (String) -> Void
    ) {
        guard listenFD < 0, acceptSource == nil else { return }
        generation += 1
        let url = AgentSocket.url
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        chmod(url.deletingLastPathComponent().path, 0o700)

        let path = url.path
        if FileManager.default.fileExists(atPath: path) {
            // Never steal a live socket from an installed/dev instance. Only unlink
            // when no listener accepts the probe, which identifies a stale node.
            guard !Self.canConnect(to: path) else {
                Log.agents.notice("agent socket already owned by another Notch instance")
                return
            }
            unlink(path)
        }

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
        ownsSocket = true

        chmod(path, 0o600)

        // Non-blocking listen fd so the accept loop drains all pending peers and
        // returns instead of blocking the queue once they're consumed.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        guard listen(fd, 8) == 0 else {
            Log.agents.error("agent socket: listen() failed errno=\(errno)")
            close(fd)
            unlink(path)
            ownsSocket = false
            return
        }

        listenFD = fd
        handler = onEnvelope
        permissionTimeoutHandler = onPermissionTimeout

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptConnections() }
        acceptSource = source
        source.resume()
        Log.agents.info("agent socket listening at \(path)")
    }

    private func teardown() {
        generation += 1
        acceptSource?.cancel()
        acceptSource = nil
        if listenFD >= 0 { close(listenFD) }
        listenFD = -1
        handler = nil
        permissionTimeoutHandler = nil
        ioQueue.cancelAllOperations()
        for fd in pendingReplies.values { close(fd) }
        pendingReplies = [:]
        if ownsSocket {
            unlink(AgentSocket.url.path)
            ownsSocket = false
        }
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
            let expectedByteCount = line.count
            let written = line.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            close(fd)
            DispatchQueue.main.async { completion(written == expectedByteCount) }
        }
    }

    private func registerPendingReply(_ requestId: String, fd: Int32, generation: Int) {
        queue.async { [weak self] in
            guard let self else { close(fd); return }
            guard self.generation == generation, self.listenFD >= 0 else {
                close(fd)
                return
            }
            // A duplicate request id would orphan the previous fd; close it first.
            if let stale = self.pendingReplies.removeValue(forKey: requestId) { close(stale) }
            self.pendingReplies[requestId] = fd
            self.queue.asyncAfter(deadline: .now() + Self.pendingWindow) { [weak self] in
                guard let self, self.generation == generation,
                      let stale = self.pendingReplies.removeValue(forKey: requestId) else { return }
                close(stale)
                let handler = self.permissionTimeoutHandler
                DispatchQueue.main.async { handler?(requestId) }
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
            let generation = self.generation
            ioQueue.addOperation { [weak self] in
                guard let self else { close(client); return }
                self.handleClient(client, handler: handler, generation: generation)
            }
        }
    }

    private func handleClient(
        _ client: Int32,
        handler: (@Sendable (HookEnvelope, pid_t) -> Void)?,
        generation: Int
    ) {
        var keepOpen = false
        defer { if !keepOpen { close(client) } }

        let peer = peerPID(of: client)
        let data = readAll(client, timeout: 2)

        for line in data.split(separator: 0x0A) where !line.isEmpty {
            guard let envelope = try? JSONDecoder().decode(HookEnvelope.self, from: Data(line)) else {
                continue
            }
            // A blocking permission hook stays connected awaiting the decision.
            if envelope.hook == "PermissionRequest", let requestId = envelope.requestId {
                registerPendingReply(requestId, fd: client, generation: generation)
                keepOpen = true
            }
            // In-process plugins connect directly, so the kernel peer pid is the
            // trustworthy liveness handle. Short-lived hook tools may report their
            // parent agent/shell pid, but those providers do not use pid liveness.
            let pid: pid_t
            if envelope.agent == AgentKind.openCode.rawValue || envelope.agent == AgentKind.ohMyPi.rawValue {
                pid = peer
            } else {
                pid = envelope.pid.map { pid_t($0) } ?? peer
            }
            handler?(envelope, pid)
        }
    }

    private func readAll(_ fd: Int32, timeout: TimeInterval) -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeout * 1_000_000_000)
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { break }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let remainingMilliseconds = Int32(min((deadline - now) / 1_000_000, UInt64(Int32.max)))
            let ready = poll(&descriptor, 1, remainingMilliseconds)
            guard ready > 0, descriptor.revents & Int16(POLLIN | POLLHUP) != 0 else { break }
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            guard n > 0 else { break } // 0 = EOF, <0 = error/timeout
            data.append(contentsOf: buffer[0..<n])
            // Both bundled clients enforce this cap before sending. Reject a
            // larger local-peer envelope rather than decoding unbounded input.
            if data.count > AgentPermissionLimits.maximumEnvelopeBytes { return Data() }
            // A trailing newline ends the batch: every client writes whole lines,
            // and returning here (instead of waiting for EOF) both avoids the 2s
            // timeout and leaves a blocking permission client's connection usable.
            if data.last == 0x0A { break }
        }
        return data
    }

    private static func canConnect(to path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = path.utf8CString
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return false }
        withUnsafeMutablePointer(to: &address.sun_path) { destination in
            destination.withMemoryRebound(to: CChar.self, capacity: bytes.count) { chars in
                bytes.withUnsafeBufferPointer { chars.update(from: $0.baseAddress!, count: bytes.count) }
            }
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, length) == 0
            }
        }
    }

    private func peerPID(of fd: Int32) -> pid_t {
        var pid: pid_t = 0
        var len = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0 else { return 0 }
        return pid
    }
}
