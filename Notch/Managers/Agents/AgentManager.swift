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

    /// Session ids currently mirrored into the pill, and the status each was last
    /// published with — so we only re-pop the pill on a real status change.
    private var pillStatus: [String: AgentStatus] = [:]

    init(activities: ActivityManager, settings: Settings) {
        self.activities = activities
        self.settings = settings
        self.notifier = AgentNotifier(activities: activities, settings: settings)
    }

    func start() {
        guard settings.agentsEnabled else { return }

        providers = [ClaudeCodeProvider(processLookup: processLookup, settings: settings)]
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
        TerminalJumper(processLookup: processLookup).jump(toPID: session.pid, cwd: session.cwd)
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

    /// Mirror only the busy / needs-attention sessions into the pill (idle ones
    /// live in the Agents tab). Re-publish a channel only when its status changed,
    /// so the pill doesn't re-pop on every transcript write.
    private func syncPill(_ sessions: [AgentSession]) {
        var shown: Set<String> = []
        for session in sessions where session.status.isBusy || session.status == .needsAttention {
            shown.insert(session.id)
            if pillStatus[session.id] != session.status {
                activities.publishAgent(session)
                pillStatus[session.id] = session.status
            }
        }
        for id in Set(pillStatus.keys).subtracting(shown) {
            activities.removeAgent(sessionID: id)
            pillStatus[id] = nil
        }
    }
}
