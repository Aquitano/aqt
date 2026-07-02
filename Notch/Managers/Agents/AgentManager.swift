import Combine
import SwiftUI

/// Aggregates the per-agent providers, owns the shared socket + process lookup +
/// notifier, reconciles their sessions into one published list, and mirrors the
/// noteworthy ones into the compact pill. Mirrors `MediaManager`'s role for the
/// agent feature.
@MainActor
final class AgentManager: ObservableObject {

    @Published private(set) var sessions: [AgentSession] = []
    /// Account-wide Claude usage limits (when enabled), from the statusLine.
    @Published private(set) var usage: AgentUsage?

    private let activities: ActivityManager
    private let settings: Settings
    let notifier: AgentNotifier

    private let socketServer = AgentSocketServer()
    private let processLookup = ProcessLookup()
    private var providers: [AgentProviding] = []
    private var sessionsByKind: [AgentKind: [AgentSession]] = [:]

    /// Last pill summary signature (count + status + project), so the pill only
    /// re-pops on a real change rather than every transcript write.
    private var pillSignature: String?

    /// start() builds providers + the socket exactly once, so it can be called both
    /// at launch and when the user flips the feature on at runtime.
    private var hasStarted = false

    init(activities: ActivityManager, settings: Settings) {
        self.activities = activities
        self.settings = settings
        self.notifier = AgentNotifier(activities: activities, settings: settings)
    }

    func start() {
        guard settings.agentsEnabled, !hasStarted else { return }
        hasStarted = true

        let installer = AgentConfigInstaller()
        providers = [
            ClaudeCodeProvider(processLookup: processLookup, settings: settings),
            // Codex hooks are short-lived subprocesses (pid unreliable) -> age out by staleness.
            SocketAgentProvider(
                kind: .codex, liveness: .staleness,
                settings: settings, enabledKey: \.agentCodexEnabled,
                install: { try installer.installCodexHooks() }, uninstall: { try installer.removeCodexHooks() }
            ),
            // OpenCode/oh-my-pi report from inside the agent process -> prune by live pid.
            SocketAgentProvider(
                kind: .openCode, liveness: .processPid,
                settings: settings, enabledKey: \.agentOpenCodeEnabled,
                install: { try installer.installOpenCodePlugin() }, uninstall: { try installer.removeOpenCodePlugin() }
            ),
            SocketAgentProvider(
                kind: .ohMyPi, liveness: .processPid,
                settings: settings, enabledKey: \.agentOhMyPiEnabled,
                install: { try installer.installOhMyPi() }, uninstall: { try installer.removeOhMyPi() }
            ),
        ]
        for provider in providers {
            provider.onSessions = { [weak self] sessions in
                self?.updateSessions(sessions, for: provider.kind)
            }
            provider.onEvent = { [weak self] event in
                self?.notifier.notify(event)
            }
            provider.start()
        }

        // Deliver envelopes through one serial stream instead of an independent
        // Task per envelope. Independent tasks have no ordering guarantee, so two
        // hooks fired back-to-back (e.g. PostToolUse then Stop) could be processed
        // reversed — leaving a session stuck "Thinking" after the turn finished.
        // A single consumer routes them in arrival order.
        let (stream, continuation) = AsyncStream.makeStream(of: (HookEnvelope, pid_t).self)
        socketServer.start { [continuation] envelope, pid in
            continuation.yield((envelope, pid))
        }
        Task { @MainActor [weak self] in
            for await (envelope, pid) in stream {
                self?.route(envelope, pid: pid)
            }
        }

        if settings.agentUsageLimits { try? installer.installClaudeUsage() }
    }


    /// Opt-in: wrap (or unwrap) Claude's statusLine to surface usage limits.
    func setUsageLimits(_ enabled: Bool) {
        let installer = AgentConfigInstaller()
        do {
            if enabled {
                try installer.installClaudeUsage()
                settings.agentUsageLimits = true
            } else {
                settings.agentUsageLimits = false
                try installer.removeClaudeUsage()
                usage = nil
            }
        } catch {
            settings.agentUsageLimits = false
            Log.agents.error("usage-limits toggle failed: \(String(describing: error))")
        }
    }

    // MARK: - UI proxies

    func provider(for kind: AgentKind) -> AgentProviding? {
        providers.first { $0.kind == kind }
    }

    /// Agents that have a provider this build (drives which Enable cards appear).
    var availableKinds: [AgentKind] { providers.map(\.kind) }

    func isInstalled(_ kind: AgentKind) -> Bool { CLIDetector().isInstalled(kind) }

    func jumpToTerminal(_ session: AgentSession) {
        TerminalJumper(processLookup: processLookup)
            .jump(toPID: session.pid, cwd: session.cwd, focusURL: session.terminalFocusURL)
    }

    /// Pull fresh state now — used when the Agents tab appears.
    func refresh() {
        providers.forEach { $0.refresh() }
    }

    func isEnabled(_ kind: AgentKind) -> Bool { provider(for: kind)?.isEnabled ?? false }


    func setEnabled(_ enabled: Bool, for kind: AgentKind) {
        guard let provider = provider(for: kind) else { return }
        objectWillChange.send()
        if enabled { provider.enable() } else { provider.disable() }
    }

    // MARK: - Routing & reconciliation

    private func route(_ envelope: HookEnvelope, pid: pid_t) {
        if envelope.status == "usage" {
            usage = AgentUsage(
                fiveHourUsedPercent: envelope.fiveHourUsed ?? 0,
                sevenDayUsedPercent: envelope.sevenDayUsed ?? 0,
                fiveHourResetsAt: envelope.fiveHourResetsAt.map { Date(timeIntervalSince1970: $0) },
                sevenDayResetsAt: envelope.sevenDayResetsAt.map { Date(timeIntervalSince1970: $0) }
            )
            return
        }
        guard let kind = AgentKind(rawValue: envelope.agent) else { return }
        provider(for: kind)?.ingest(envelope, pid: pid)
    }

    private func updateSessions(_ sessions: [AgentSession], for kind: AgentKind) {
        sessionsByKind[kind] = sessions
        let merged = AgentKind.allCases
            .flatMap { sessionsByKind[$0] ?? [] }
            .sorted { $0.lastActivity > $1.lastActivity }
        self.sessions = merged
        syncPill(merged)
    }

    /// Mirror the active agents into the pill as one aggregate entry showing the
    /// running count + the most important status (idle ones live in the Agents
    /// tab). Only re-publish when that summary actually changes.
    private func syncPill(_ sessions: [AgentSession]) {
        let active = sessions.filter { $0.status.isBusy || $0.status == .needsAttention }
        guard let representative = active.first(where: { $0.status == .needsAttention })
            ?? active.max(by: { $0.lastActivity < $1.lastActivity }) else {
            if pillSignature != nil { activities.removeAgentSummary(); pillSignature = nil }
            return
        }

        let needsAttention = active.contains { $0.status == .needsAttention }
        let status: AgentStatus = needsAttention ? .needsAttention : representative.status
        let signature = "\(active.count)|\(status.rawValue)|\(representative.project)"
        guard signature != pillSignature else { return }
        pillSignature = signature
        activities.publishAgentSummary(
            count: active.count, kind: representative.kind,
            project: representative.project, status: status
        )
    }
}
