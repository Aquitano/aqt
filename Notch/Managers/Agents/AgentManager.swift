import Combine
import SwiftUI

/// Aggregates the per-agent providers, owns the shared socket + process lookup +
/// notifier, reconciles their sessions into one published list, and mirrors the
/// noteworthy ones into the compact pill. Mirrors `MediaManager`'s role for the
/// agent feature.
@MainActor
final class AgentManager: ObservableObject {

    @Published private(set) var sessions: [AgentSession] = []

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

    init(activities: ActivityManager, settings: Settings) {
        self.activities = activities
        self.settings = settings
        self.notifier = AgentNotifier(activities: activities, settings: settings)
    }

    func start() {
        guard settings.agentsEnabled else { return }

        let installer = AgentConfigInstaller()
        providers = [
            ClaudeCodeProvider(processLookup: processLookup, settings: settings),
            // Codex hooks are short-lived subprocesses (pid unreliable) -> age out by staleness.
            SocketAgentProvider(
                kind: .codex, capabilities: [.liveEvents, .attention], liveness: .staleness,
                settings: settings, enabledKey: \.agentCodexEnabled,
                install: { try installer.installCodexHooks() }, uninstall: { try installer.removeCodexHooks() }
            ),
            // OpenCode/oh-my-pi report from inside the agent process -> prune by live pid.
            SocketAgentProvider(
                kind: .openCode, capabilities: [.liveEvents, .attention], liveness: .processPid,
                settings: settings, enabledKey: \.agentOpenCodeEnabled,
                install: { try installer.installOpenCodePlugin() }, uninstall: { try installer.removeOpenCodePlugin() }
            ),
            SocketAgentProvider(
                kind: .ohMyPi, capabilities: [.liveEvents, .attention], liveness: .processPid,
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

        socketServer.start { [weak self] envelope, pid in
            Task { @MainActor in self?.route(envelope, pid: pid) }
        }
    }

    // MARK: - UI proxies

    func provider(for kind: AgentKind) -> AgentProviding? {
        providers.first { $0.kind == kind }
    }

    /// Agents that have a provider this build (drives which Enable cards appear).
    var availableKinds: [AgentKind] { providers.map(\.kind) }

    func jumpToTerminal(_ session: AgentSession) {
        TerminalJumper(processLookup: processLookup)
            .jump(toPID: session.pid, cwd: session.cwd, focusURL: session.terminalFocusURL)
    }

    /// Pull fresh state now — used when the Agents tab appears.
    func refresh() {
        providers.forEach { $0.refresh() }
    }

    func isEnabled(_ kind: AgentKind) -> Bool { provider(for: kind)?.isEnabled ?? false }

    func capabilities(_ kind: AgentKind) -> AgentProviderCapabilities { provider(for: kind)?.capabilities ?? [] }

    func setEnabled(_ enabled: Bool, for kind: AgentKind) {
        guard let provider = provider(for: kind) else { return }
        objectWillChange.send()
        if enabled { provider.enable() } else { provider.disable() }
    }

    // MARK: - Routing & reconciliation

    private func route(_ envelope: HookEnvelope, pid: pid_t) {
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
