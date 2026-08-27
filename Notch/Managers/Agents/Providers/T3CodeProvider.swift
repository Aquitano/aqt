import Foundation

/// Watches the local T3 Code server (Theo's agent harness) as a read-only
/// client: pair once with a `t3 pair` link, then hold a WebSocket subscription
/// to its orchestration shell stream and mirror the live threads as sessions.
/// Unlike the hook-based providers there is nothing to install — enable/disable
/// only manage the paired credential. All wire decoding lives in `T3Wire`;
/// this class owns auth, the socket, and the reconnect loop.
@MainActor
final class T3CodeProvider: AgentProviding {

    let kind: AgentKind = .t3code
    var onSessions: (([AgentSession]) -> Void)?
    var onEvent: ((AgentEvent) -> Void)?
    /// Protocol-drift report for the Settings footer: a message when decoding
    /// t3's stream starts failing, nil when a later frame decodes cleanly again.
    var onDrift: ((String?) -> Void)?

    private let settings: Settings
    private var connectionTask: Task<Void, Never>?
    private var published: [String: AgentSession] = [:]
    private var serverVersion: String?
    private var warnedVersion: String?
    private var driftReported = false

    private static let keychainAccount = "t3code-access-token"

    init(settings: Settings) {
        self.settings = settings
    }

    var isEnabled: Bool { settings.agentT3Enabled }
    var isPaired: Bool { KeychainStore.get(account: Self.keychainAccount) != nil }

    // MARK: - Lifecycle

    func start() {
        guard isEnabled else { return }
        connect()
    }

    func stop() {
        connectionTask?.cancel()
        connectionTask = nil
        published = [:]
        onSessions?([])
    }

    /// Enabling requires an existing paired token (`pair(link:)` is the real
    /// opt-in and flips the setting itself); this path only covers re-enabling.
    func enable() throws {
        guard isPaired else { throw T3PairingError.notPaired }
        settings.agentT3Enabled = true
        connect()
    }

    /// Disabling forgets the credential — t3 sessions are remote state, so the
    /// clean "off" is unpaired. Re-enabling asks for a fresh pairing link.
    func disable() {
        settings.agentT3Enabled = false
        KeychainStore.delete(account: Self.keychainAccount)
        stop()
    }

    func refresh() {
        guard isEnabled, connectionTask == nil else { return }
        connect()
    }

    /// t3 speaks its own WebSocket, not the hook socket.
    func ingest(_ envelope: HookEnvelope, pid: pid_t) {}

    // MARK: - Pairing

    /// Trade a pairing link (or bare credential) for a read-only bearer token
    /// and start watching. The token goes to the Keychain, never UserDefaults.
    func pair(link: String) async throws {
        guard let parsed = T3Wire.pairingLink(link) else { throw T3PairingError.invalidLink }
        let base = parsed.baseURL
            ?? URL(string: settings.agentT3BaseURL)
            ?? URL(string: Settings.defaultT3BaseURL)!
        let token = try await exchangeToken(credential: parsed.credential, base: base)
        try KeychainStore.set(token, account: Self.keychainAccount)
        settings.agentT3BaseURL = base.absoluteString
        settings.agentT3Enabled = true
        connect()
    }

    private func exchangeToken(credential: String, base: URL) async throws -> String {
        var request = URLRequest(url: base.appendingPathComponent("oauth/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = T3Wire.tokenExchangeBody(credential: credential)
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw T3PairingError.exchangeFailed(status: (response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = object["access_token"] as? String, !token.isEmpty else {
            throw T3PairingError.exchangeFailed(status: 200)
        }
        return token
    }

    // MARK: - Connection loop

    private func connect() {
        connectionTask?.cancel()
        connectionTask = Task { [weak self] in
            await self?.runLoop()
        }
    }

    private func runLoop() async {
        var backoff: TimeInterval = 3
        // Consecutive ws connections that closed before delivering any chunk —
        // the signature of a renamed subscribe method or protocol handshake.
        var chunklessConnections = 0
        while !Task.isCancelled, isEnabled {
            do {
                let sawChunk = try await runConnection()
                chunklessConnections = sawChunk ? 0 : chunklessConnections + 1
                backoff = 3 // stream ended cleanly (server restart): retry soon
            } catch is CancellationError {
                return
            } catch let error as T3PairingError {
                // Token rejected: retrying fast would spam a dead credential.
                Log.agents.notice("t3: auth failed (\(error.localizedDescription)) — retrying in 5m")
                backoff = 300
            } catch T3ConnectionError.framingUndecodable {
                chunklessConnections = 0
                await runPollFallback()
            } catch {
                // Server not running is the normal quiet case.
                Log.agents.debug("t3: connection ended: \(String(describing: error))")
            }
            if chunklessConnections >= 3 {
                chunklessConnections = 0
                await runPollFallback()
            }
            if !published.isEmpty {
                // State is unknowable while disconnected; clear rather than lie.
                published = [:]
                onSessions?([])
            }
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 60)
        }
    }

    private var credentials: (base: URL, token: String) {
        get throws {
            guard let token = KeychainStore.get(account: Self.keychainAccount) else {
                throw T3PairingError.notPaired
            }
            guard let base = URL(string: settings.agentT3BaseURL) else {
                throw T3PairingError.invalidLink
            }
            return (base, token)
        }
    }

    /// Returns whether the stream delivered at least one chunk before ending.
    private func runConnection() async throws -> Bool {
        let (base, token) = try credentials
        await checkServerVersion(base: base)
        let ticket = try await fetchWebSocketTicket(base: base, token: token)

        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw T3PairingError.invalidLink
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws"
        components.queryItems = [URLQueryItem(name: "wsTicket", value: ticket)]
        guard let wsURL = components.url else { throw T3PairingError.invalidLink }

        let socket = URLSession.shared.webSocketTask(with: wsURL)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }

        try await send(T3Wire.subscribeShellRequest(id: "1"), over: socket)

        var state = T3ShellState()
        // Events are suppressed until the first snapshot has been applied, so a
        // (re)connect never replays started/finished for already-known sessions.
        var live = false
        var sawChunk = false
        var undecodedFrames = 0
        while !Task.isCancelled {
            let data = try await receiveData(from: socket)
            let messages = T3Wire.decodeFrames(data)
            // Frames we can't even parse envelopes from mean the RPC framing
            // itself moved (an effect upgrade) — switch to HTTP polling.
            if messages.isEmpty {
                undecodedFrames += 1
                if undecodedFrames >= 3 { throw T3ConnectionError.framingUndecodable }
                continue
            }
            undecodedFrames = 0
            for message in messages {
                switch message {
                case let .chunk(requestId, items, drift):
                    sawChunk = true
                    // Ack releases the server's next chunk (stream backpressure).
                    try await send(T3Wire.ack(requestId), over: socket)
                    var sawSnapshot = false
                    for item in items {
                        if case .snapshot = item { sawSnapshot = true }
                        state.apply(item)
                    }
                    publish(state, emitEvents: live && !sawSnapshot)
                    if sawSnapshot { live = true }
                    if drift { reportDrift() } else if sawSnapshot { clearDrift() }
                case .exit, .defect:
                    return sawChunk
                case .pong:
                    break
                }
            }
        }
        return sawChunk
    }

    // MARK: - HTTP polling fallback

    private static let pollInterval: TimeInterval = 10
    private static let pollWindow: TimeInterval = 300

    /// Degraded mode when the ws stream is unusable but the server is up: poll
    /// `GET /api/orchestration/shell` (the same snapshot shape, no Effect-RPC
    /// framing) so tracking and notifications keep working with ~10s latency.
    /// Runs for one window, then returns so the loop can retry the ws stream.
    private func runPollFallback() async {
        Log.agents.notice("t3: ws stream unusable — polling /api/orchestration/shell every \(Int(Self.pollInterval))s")
        do {
            try await pollShell()
            Log.agents.info("t3: poll window over — retrying the ws stream")
        } catch is CancellationError {
        } catch {
            Log.agents.debug("t3: snapshot polling ended: \(String(describing: error))")
        }
    }

    private func pollShell() async throws {
        let (base, token) = try credentials
        let deadline = Date().addingTimeInterval(Self.pollWindow)
        // With recent state still published, diffs stay meaningful; from a cold
        // start the first poll seeds silently, mirroring the ws snapshot rule.
        var live = !published.isEmpty
        while !Task.isCancelled, isEnabled, Date() < deadline {
            let decoded = T3Wire.shellSnapshotResponse(try await fetchShellSnapshot(base: base, token: token))
            if decoded.drift { reportDrift() }
            guard let item = decoded.item else { throw T3ConnectionError.framingUndecodable }
            var state = T3ShellState()
            state.apply(item)
            publish(state, emitEvents: live)
            if !decoded.drift { clearDrift() }
            live = true
            try await Task.sleep(for: .seconds(Self.pollInterval))
        }
    }

    private func fetchShellSnapshot(base: URL, token: String) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent("api/orchestration/shell"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 || http.statusCode == 403 { throw T3PairingError.tokenRejected }
        guard http.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }

    /// Best-effort version gate: read the unauthenticated environment
    /// descriptor, log the server version, and warn once per version when it's
    /// newer than the last one this decoder was verified against. Never blocks
    /// the connection — drift detection is the actual tripwire.
    private func checkServerVersion(base: URL) async {
        var request = URLRequest(url: base.appendingPathComponent(".well-known/t3/environment"))
        request.timeoutInterval = 5
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["serverVersion"] as? String else { return }
        serverVersion = version
        Log.agents.info("t3: server version \(version)")
        if T3Wire.isVersion(version, newerThan: T3Wire.verifiedServerVersion), warnedVersion != version {
            warnedVersion = version
            Log.agents.notice("t3: server \(version) is newer than verified \(T3Wire.verifiedServerVersion) — protocol may have drifted")
        }
    }

    /// One report per drift episode; a later clean snapshot clears it.
    private func reportDrift() {
        guard !driftReported else { return }
        driftReported = true
        let server = serverVersion ?? "unknown"
        Log.agents.error("t3: stream payload no longer decodes (server \(server), verified \(T3Wire.verifiedServerVersion))")
        onDrift?("T3 Code protocol changed (server \(server), verified against \(T3Wire.verifiedServerVersion)) — sessions may be missing until Notch is updated.")
    }

    private func clearDrift() {
        guard driftReported else { return }
        driftReported = false
        onDrift?(nil)
    }

    private func fetchWebSocketTicket(base: URL, token: String) async throws -> String {
        var request = URLRequest(url: base.appendingPathComponent("api/auth/websocket-ticket"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw T3PairingError.tokenRejected
        }
        guard http.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ticket = object["ticket"] as? String else {
            throw URLError(.badServerResponse)
        }
        return ticket
    }

    private func send(_ data: Data, over socket: URLSessionWebSocketTask) async throws {
        guard let text = String(data: data, encoding: .utf8) else { return }
        try await socket.send(.string(text))
    }

    private func receiveData(from socket: URLSessionWebSocketTask) async throws -> Data {
        switch try await socket.receive() {
        case let .string(text): return Data(text.utf8)
        case let .data(data): return data
        @unknown default: return Data()
        }
    }

    private func publish(_ state: T3ShellState, emitEvents: Bool) {
        let current = state.sessions(previous: published, now: Date())
        guard current != published else { return }
        if emitEvents {
            for event in T3Wire.events(previous: published, current: current) {
                onEvent?(event)
            }
        }
        published = current
        onSessions?(current.values.sorted { $0.lastActivity > $1.lastActivity })
    }
}

enum T3ConnectionError: Error {
    /// The ws stream is reachable but no longer speaks a framing we can read.
    case framingUndecodable
}

enum T3PairingError: LocalizedError {
    case notPaired
    case invalidLink
    case exchangeFailed(status: Int)
    case tokenRejected

    var errorDescription: String? {
        switch self {
        case .notPaired:
            return "Paste a pairing link from `t3 pair` first."
        case .invalidLink:
            return "That doesn't look like a t3 pairing link."
        case let .exchangeFailed(status):
            return "The t3 server rejected the pairing link (HTTP \(status))."
        case .tokenRejected:
            return "The t3 server rejected the stored token — pair again."
        }
    }
}
