import Foundation

/// Pure wire layer for the T3 Code integration: encodes/decodes the Effect-RPC
/// JSON frames the local t3 server speaks on `/ws` and folds its orchestration
/// shell stream into `AgentSession`s. No networking here — `T3CodeProvider`
/// owns the socket and auth; this file owns every byte-level decision so it can
/// be fixture-tested.
///
/// Wire shape (effect/unstable/rpc with JSON serialization): each WebSocket
/// text frame is one JSON message, or an array of them. Client -> server:
/// `{"_tag":"Request","id","tag","payload","headers":[]}` and
/// `{"_tag":"Ack","requestId"}` (every Chunk must be acked to release the
/// next). Server -> client: `{"_tag":"Chunk","requestId","values":[...]}`,
/// `{"_tag":"Exit",...}`, `{"_tag":"Pong"}`, `{"_tag":"Defect",...}`.
///
/// This is t3's internal protocol with no stability promise, so decoding is
/// deliberately tolerant: unknown tags, item kinds, and fields are skipped, and
/// a decode miss degrades to "no update", never a crash.
enum T3Wire {

    static let subscribeShellMethod = "orchestration.subscribeShell"

    // MARK: - Client -> server frames

    static func subscribeShellRequest(id: String) -> Data {
        frame([
            "_tag": "Request",
            "id": id,
            "tag": subscribeShellMethod,
            "payload": [String: String](),
            "headers": [[String]](),
        ])
    }

    static func ack(_ requestId: T3RequestID) -> Data {
        frame(["_tag": "Ack", "requestId": requestId.jsonValue])
    }

    private static func frame(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    // MARK: - Server -> client frames

    static func decodeFrames(_ data: Data) -> [T3ServerMessage] {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return [] }
        let list = root as? [Any] ?? [root]
        return list.compactMap { message(from: $0 as? [String: Any]) }
    }

    private static func message(from dict: [String: Any]?) -> T3ServerMessage? {
        guard let dict, let tag = dict["_tag"] as? String else { return nil }
        switch tag {
        case "Chunk":
            guard let requestId = T3RequestID(dict["requestId"]) else { return nil }
            let values = dict["values"] as? [Any] ?? []
            var items: [T3ShellItem] = []
            var drift = false
            for value in values {
                let decoded = shellItem(from: value as? [String: Any])
                if let item = decoded.item { items.append(item) }
                if decoded.drift { drift = true }
            }
            // A non-empty chunk that decodes to nothing means the schema moved
            // under us, not that t3 is quiet.
            if !values.isEmpty && items.isEmpty { drift = true }
            return .chunk(requestId: requestId, items: items, drift: drift)
        case "Exit":
            return .exit
        case "Pong":
            return .pong
        case "Defect", "ClientProtocolError":
            return .defect
        default:
            return nil
        }
    }

    /// `drift` marks a value that carried real payload we could no longer read
    /// — the "t3 changed its schema" signal, as opposed to benign unknowns.
    private static func shellItem(from dict: [String: Any]?) -> (item: T3ShellItem?, drift: Bool) {
        guard let dict, let kind = dict["kind"] as? String else { return (nil, false) }
        switch kind {
        case "snapshot":
            guard let snapshot = dict["snapshot"] as? [String: Any] else { return (nil, true) }
            return snapshotItem(from: snapshot)
        case "project-upserted":
            return (T3Project(dict["project"] as? [String: Any]).map(T3ShellItem.projectUpserted), false)
        case "project-removed":
            return ((dict["projectId"] as? String).map(T3ShellItem.projectRemoved), false)
        case "thread-upserted":
            let thread = T3Thread(dict["thread"] as? [String: Any])
            return (thread.map(T3ShellItem.threadUpserted), thread == nil)
        case "thread-removed":
            return ((dict["threadId"] as? String).map(T3ShellItem.threadRemoved), false)
        case "synchronized":
            return (.synchronized, false)
        default:
            // Unknown kinds may be legitimate additions; only the all-failed
            // check in the chunk decoder treats them as drift.
            return (nil, false)
        }
    }

    /// Shared by the ws stream's snapshot item and the HTTP fallback route —
    /// `GET /api/orchestration/shell` returns this same shape bare.
    private static func snapshotItem(from snapshot: [String: Any]) -> (item: T3ShellItem?, drift: Bool) {
        let rawThreads = snapshot["threads"] as? [Any] ?? []
        let projects = (snapshot["projects"] as? [Any] ?? [])
            .compactMap { T3Project($0 as? [String: Any]) }
        let threads = rawThreads.compactMap { T3Thread($0 as? [String: Any]) }
        return (.snapshot(projects: projects, threads: threads),
                !rawThreads.isEmpty && threads.isEmpty)
    }

    /// Decode the HTTP shell-snapshot response (the polling fallback when the
    /// ws framing breaks). nil item = the response wasn't a shell snapshot.
    static func shellSnapshotResponse(_ data: Data) -> (item: T3ShellItem?, drift: Bool) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["threads"] != nil || object["projects"] != nil else {
            return (nil, true)
        }
        return snapshotItem(from: object)
    }

    // MARK: - Server version gate

    /// The newest t3 server version this wire layer has been verified against.
    /// A newer server doesn't block anything — it's logged, and named in the
    /// drift report when decoding actually breaks.
    static let verifiedServerVersion = "0.0.35"

    /// Numeric-component comparison ("0.0.40" > "0.0.35"); non-numeric parts
    /// are ignored, missing components read as 0.
    static func isVersion(_ version: String, newerThan reference: String) -> Bool {
        let lhs = numericComponents(version)
        let rhs = numericComponents(reference)
        for index in 0..<max(lhs.count, rhs.count) {
            let a = index < lhs.count ? lhs[index] : 0
            let b = index < rhs.count ? rhs[index] : 0
            if a != b { return a > b }
        }
        return false
    }

    private static func numericComponents(_ version: String) -> [Int] {
        version.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    }

    // MARK: - Auth plumbing (pure request-building)

    /// Accepts a full pairing URL (`http://host:port/pair#token=…`, as printed
    /// by `t3 pair` / shown as its QR code) or a bare bootstrap credential.
    static func pairingLink(_ raw: String) -> (credential: String, baseURL: URL?)? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.contains("://"), let components = URLComponents(string: trimmed) else {
            // No URL structure: treat the paste as the credential itself.
            return trimmed.contains(" ") ? nil : (credential: trimmed, baseURL: nil)
        }
        // The credential rides in the fragment (never sent over the network by
        // browsers), URLSearchParams-encoded: "#token=<credential>".
        var fragmentComponents = URLComponents()
        fragmentComponents.percentEncodedQuery = components.fragment
        guard let token = fragmentComponents.queryItems?
            .first(where: { $0.name == "token" })?.value, !token.isEmpty else { return nil }
        var base = components
        base.path = ""
        base.fragment = nil
        base.queryItems = nil
        return (credential: token, baseURL: base.url)
    }

    /// RFC 8693 token-exchange body trading a pairing credential for a bearer
    /// token. Requests only `orchestration:read` — the notch watches, it never
    /// operates.
    static func tokenExchangeBody(credential: String) -> Data {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "grant_type", value: "urn:ietf:params:oauth:grant-type:token-exchange"),
            URLQueryItem(name: "subject_token", value: credential),
            URLQueryItem(name: "subject_token_type", value: "urn:t3:params:oauth:token-type:environment-bootstrap"),
            URLQueryItem(name: "requested_token_type", value: "urn:ietf:params:oauth:token-type:access_token"),
            URLQueryItem(name: "scope", value: "orchestration:read"),
            URLQueryItem(name: "client_label", value: "Notch"),
        ]
        return Data((components.percentEncodedQuery ?? "").utf8)
    }

    // MARK: - Session mapping + event diff

    /// One t3 thread as an `AgentSession`, or nil when it shouldn't be listed
    /// (archived, or no live runtime). `previous` preserves `startedAt` across
    /// updates so uptime doesn't reset on every event.
    static func session(for thread: T3Thread,
                        project: T3Project?,
                        previous: AgentSession?,
                        now: Date) -> AgentSession? {
        guard let status = status(of: thread) else { return nil }
        var session = AgentSession(
            id: "t3-\(thread.id)",
            kind: .t3code,
            project: project?.title ?? agentProjectName(thread.worktreePath),
            cwd: thread.worktreePath ?? project?.workspaceRoot,
            status: status,
            startedAt: previous?.startedAt ?? now,
            lastActivity: thread.updatedAt ?? now
        )
        session.gitBranch = thread.branch
        session.lastPrompt = agentClip(thread.title, max: 80)
        session.terminalName = thread.providerName
        return session
    }

    /// t3 session status -> our `AgentStatus`. Threads with no live runtime
    /// (idle, stopped, errored, or no session row) are hidden — t3 keeps every
    /// historical thread around, and the Agents tab is a list of what's running.
    static func status(of thread: T3Thread) -> AgentStatus? {
        guard !thread.archived else { return nil }
        if thread.needsUser { return .needsAttention }
        switch thread.sessionStatus {
        case "starting", "running": return .running
        // "ready": the turn completed and the runtime awaits the next prompt.
        case "ready": return .finished
        default: return nil
        }
    }

    /// Notify-worthy transitions between two published session maps. The caller
    /// suppresses this for the initial snapshot so reconnecting never replays
    /// notifications for sessions that were already running.
    static func events(previous: [String: AgentSession],
                       current: [String: AgentSession]) -> [AgentEvent] {
        var events: [AgentEvent] = []
        for (id, session) in current {
            guard let old = previous[id] else {
                events.append(AgentEvent(kind: .started, session: session, message: nil))
                continue
            }
            guard old.status != session.status else { continue }
            if session.status == .needsAttention {
                events.append(AgentEvent(kind: .needsAttention, session: session, message: session.lastPrompt))
            } else if session.status == .finished {
                events.append(AgentEvent(kind: .finished, session: session, message: nil))
            }
        }
        for (id, session) in previous where current[id] == nil {
            events.append(AgentEvent(kind: .ended, session: session, message: nil))
        }
        return events
    }
}

/// Effect RPC request ids are `string | number` on the wire; acks must echo the
/// exact value back.
enum T3RequestID: Equatable {
    case string(String)
    case number(Int)

    init?(_ raw: Any?) {
        if let string = raw as? String { self = .string(string) }
        else if let number = raw as? Int { self = .number(number) }
        else { return nil }
    }

    var jsonValue: Any {
        switch self {
        case let .string(value): return value
        case let .number(value): return value
        }
    }
}

enum T3ServerMessage: Equatable {
    /// A batch of stream items; must be acked with its `requestId`. `drift` is
    /// true when the chunk carried payload the decoder could no longer read.
    case chunk(requestId: T3RequestID, items: [T3ShellItem], drift: Bool)
    /// The subscription terminated server-side (shutdown or error) — reconnect.
    case exit
    case pong
    case defect
}

enum T3ShellItem: Equatable {
    case snapshot(projects: [T3Project], threads: [T3Thread])
    case projectUpserted(T3Project)
    case projectRemoved(String)
    case threadUpserted(T3Thread)
    case threadRemoved(String)
    case synchronized
}

struct T3Project: Equatable {
    let id: String
    var title: String
    var workspaceRoot: String?

    init?(_ dict: [String: Any]?) {
        guard let dict, let id = dict["id"] as? String,
              let title = dict["title"] as? String else { return nil }
        self.id = id
        self.title = title
        self.workspaceRoot = dict["workspaceRoot"] as? String
    }
}

struct T3Thread: Equatable {
    let id: String
    var projectId: String?
    var title: String
    var branch: String?
    var worktreePath: String?
    var archived: Bool
    /// Pending approval or user-input request — the thread is blocked on a human.
    var needsUser: Bool
    /// Raw t3 session status ("starting" | "running" | "ready" | "idle" |
    /// "interrupted" | "stopped" | "error"), nil when the thread has no session.
    var sessionStatus: String?
    /// Underlying agent driving the thread (e.g. "claude-code"), for the badge.
    var providerName: String?
    var updatedAt: Date?

    init?(_ dict: [String: Any]?) {
        guard let dict, let id = dict["id"] as? String,
              let title = dict["title"] as? String else { return nil }
        self.id = id
        self.projectId = dict["projectId"] as? String
        self.title = title
        self.branch = dict["branch"] as? String
        self.worktreePath = dict["worktreePath"] as? String
        self.archived = dict["archivedAt"] as? String != nil
        self.needsUser = (dict["hasPendingApprovals"] as? Bool ?? false)
            || (dict["hasPendingUserInput"] as? Bool ?? false)
        let session = dict["session"] as? [String: Any]
        self.sessionStatus = session?["status"] as? String
        self.providerName = session?["providerName"] as? String
        self.updatedAt = (dict["updatedAt"] as? String).flatMap(T3Thread.date)
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let iso = ISO8601DateFormatter()

    private static func date(_ raw: String) -> Date? {
        isoFractional.date(from: raw) ?? iso.date(from: raw)
    }
}

/// The client-side fold of t3's shell stream: a snapshot replaces everything,
/// upsert/remove events patch in place.
struct T3ShellState {
    private(set) var projects: [String: T3Project] = [:]
    private(set) var threads: [String: T3Thread] = [:]

    mutating func apply(_ item: T3ShellItem) {
        switch item {
        case let .snapshot(newProjects, newThreads):
            // uniquingKeysWith: a duplicated id in a malformed frame must not trap.
            projects = Dictionary(newProjects.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            threads = Dictionary(newThreads.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        case let .projectUpserted(project):
            projects[project.id] = project
        case let .projectRemoved(id):
            projects[id] = nil
        case let .threadUpserted(thread):
            threads[thread.id] = thread
        case let .threadRemoved(id):
            threads[id] = nil
        case .synchronized:
            break
        }
    }

    /// Map the current shell into sessions keyed by session id.
    func sessions(previous: [String: AgentSession], now: Date) -> [String: AgentSession] {
        var result: [String: AgentSession] = [:]
        for thread in threads.values {
            let project = thread.projectId.flatMap { projects[$0] }
            guard let session = T3Wire.session(
                for: thread, project: project, previous: previous["t3-\(thread.id)"], now: now
            ) else { continue }
            result[session.id] = session
        }
        return result
    }
}
