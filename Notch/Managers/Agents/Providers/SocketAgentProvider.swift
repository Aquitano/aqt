import AppKit
import Darwin
import Foundation

/// Event-driven agent provider: builds and reconciles sessions purely from
/// socket envelopes (Codex hooks, the OpenCode plugin, the oh-my-pi extension),
/// which all emit a normalized `status`. Liveness is either the reporting
/// process's pid (when the client runs *inside* the agent) or staleness (when it
/// runs as a short-lived hook). Configured per agent; the same class serves all
/// three (and future ones).
@MainActor
final class SocketAgentProvider: AgentProviding {

    enum Liveness { case processPid, staleness }

    let kind: AgentKind
    var onSessions: (([AgentSession]) -> Void)?
    var onEvent: ((AgentEvent) -> Void)?

    private let settings: Settings
    private let enabledKey: ReferenceWritableKeyPath<Settings, Bool>
    private let liveness: Liveness
    private let install: () throws -> Void
    private let uninstall: () throws -> Void

    private var sessions: [String: AgentSession] = [:]
    private var pruneTask: Task<Void, Never>?
    private static let staleAfter: TimeInterval = 30 * 60
    /// While a pid-tracked session is busy, re-check its liveness on this cadence so
    /// a process killed mid-turn (no "ended" envelope) is dropped promptly.
    private static let livenessRecheck: TimeInterval = 8

    init(kind: AgentKind,
         liveness: Liveness,
         settings: Settings,
         enabledKey: ReferenceWritableKeyPath<Settings, Bool>,
         install: @escaping () throws -> Void,
         uninstall: @escaping () throws -> Void) {
        self.kind = kind
        self.liveness = liveness
        self.settings = settings
        self.enabledKey = enabledKey
        self.install = install
        self.uninstall = uninstall
    }

    var isEnabled: Bool { settings[keyPath: enabledKey] }

    // MARK: - Lifecycle

    func start() {
        guard isEnabled else { return }
        try? install() // keep installed files current
    }

    func stop() {
        pruneTask?.cancel()
        pruneTask = nil
    }

    func enable() {
        do {
            try install()
            settings[keyPath: enabledKey] = true
            Log.agents.info("\(self.kind.rawValue) integration installed")
        } catch {
            settings[keyPath: enabledKey] = false
            Log.agents.error("\(self.kind.rawValue) enable failed: \(String(describing: error))")
        }
    }

    func disable() {
        settings[keyPath: enabledKey] = false
        try? uninstall()
        stop()
        sessions = [:]
        onSessions?([])
    }

    func refresh() {
        guard isEnabled else { return }
        prune()
        publish()
    }

    // MARK: - Ingest

    func ingest(_ envelope: HookEnvelope, pid: pid_t) {
        // A still-running agent keeps its hooks/plugin loaded after the user toggles
        // the integration off; without this guard its envelopes rebuild and
        // re-publish sessions while the feature is disabled.
        guard isEnabled else { return }
        guard let sid = envelope.sessionId else { return }
        let raw = envelope.status ?? "busy"

        if raw == "ended" {
            if let gone = sessions.removeValue(forKey: sid) {
                onEvent?(AgentEvent(kind: .ended, session: gone, message: nil))
            }
            publish()
            return
        }

        let previous = sessions[sid]
        var session = previous ?? AgentSession(
            id: sid, kind: kind, project: agentProjectName(envelope.cwd ?? envelope.project),
            cwd: envelope.cwd, status: .idle, startedAt: Date(), lastActivity: Date()
        )
        session.status = mapStatus(raw, tool: envelope.tool)
        session.activityVerb = session.status.isBusy
            ? (envelope.tool.map(agentToolVerb) ?? (session.status == .running ? "Thinking" : nil))
            : nil
        if let cwd = envelope.cwd { session.cwd = cwd; session.project = agentProjectName(cwd) }
        else if let project = envelope.project { session.project = project }
        session.lastActivity = Date()
        if liveness == .processPid, pid > 0 { session.pid = pid }
        if let prompt = envelope.prompt, !prompt.isEmpty { session.lastPrompt = agentClip(prompt) }
        if let response = envelope.response, !response.isEmpty { session.lastResponse = agentClip(response) }
        if let model = envelope.model, !model.isEmpty { session.detail = model }
        if let parent = envelope.parent, !parent.isEmpty { session.parentSessionID = parent }

        emitEvents(sid: sid, previous: previous, session: session, message: envelope.message)
        sessions[sid] = session
        prune()
        publish()
        scheduleLivenessRecheck()
    }

    // MARK: - Mapping + events

    private func mapStatus(_ raw: String, tool: String?) -> AgentStatus {
        switch raw {
        case "started", "busy": return tool.map(Self.toolStatus) ?? .running
        case "tool": return tool.map(Self.toolStatus) ?? .tool
        case "editing": return .editing
        case "idle": return .idle
        case "finished": return .finished
        case "waiting", "needs_attention": return .needsAttention
        default: return .running
        }
    }

    private static func toolStatus(_ tool: String) -> AgentStatus {
        let edit: Set<String> = ["edit", "write", "apply_patch", "multiedit", "str_replace_editor", "notebookedit"]
        return edit.contains(tool.lowercased()) ? .editing : .tool
    }

    private func emitEvents(sid: String, previous: AgentSession?, session: AgentSession, message: String?) {
        if session.status == .needsAttention {
            // Fire on entering attention (consecutive permission asks are separated
            // by activity, so each transition is distinct; the notifier rate-limits).
            if previous?.status != .needsAttention {
                onEvent?(AgentEvent(kind: .needsAttention, session: session, message: message ?? session.lastPrompt))
            }
            return
        }
        guard let previous else {
            onEvent?(AgentEvent(kind: .started, session: session, message: nil))
            return
        }
        if previous.status != session.status, session.status == .finished {
            onEvent?(AgentEvent(kind: .finished, session: session, message: nil))
        }
    }

    // MARK: - Liveness

    private func prune() {
        let now = Date()
        for (sid, session) in Array(sessions) {
            switch liveness {
            case .processPid:
                if let pid = session.pid {
                    if !Self.isAlive(pid) { remove(sid, session) }
                } else if now.timeIntervalSince(session.lastActivity) > Self.staleAfter {
                    // No pid to check (peer pid was 0): fall back to staleness so it
                    // can't live forever.
                    remove(sid, session)
                }
            case .staleness:
                if now.timeIntervalSince(session.lastActivity) > Self.staleAfter { remove(sid, session) }
            }
        }
    }

    private func remove(_ sid: String, _ session: AgentSession) {
        sessions[sid] = nil
        onEvent?(AgentEvent(kind: .ended, session: session, message: nil))
    }

    /// Re-prune without further events. Staleness ages sessions out on a one-shot;
    /// pid liveness re-checks on a cadence while any session is busy, re-arming
    /// itself until nothing is busy, so a process killed mid-turn is dropped even
    /// though no "ended" envelope ever arrives.
    private func scheduleLivenessRecheck() {
        pruneTask?.cancel()
        switch liveness {
        case .staleness:
            pruneTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.staleAfter + 1))
                guard !Task.isCancelled, let self else { return }
                self.prune()
                self.publish()
            }
        case .processPid:
            guard sessions.values.contains(where: { $0.status.isBusy }) else {
                pruneTask = nil
                return
            }
            pruneTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.livenessRecheck))
                guard !Task.isCancelled, let self else { return }
                self.prune()
                self.publish()
                self.scheduleLivenessRecheck()
            }
        }
    }

    private func publish() { onSessions?(Array(sessions.values)) }

    private static func isAlive(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }


}
