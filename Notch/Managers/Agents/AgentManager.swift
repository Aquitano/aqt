import Combine
import SwiftUI
import AppKit

/// Aggregates the per-agent providers, owns the shared socket + process lookup +
/// notifier, reconciles their sessions into one published list, and mirrors the
/// noteworthy ones into the compact pill. Mirrors `MediaManager`'s role for the
/// agent feature.
@MainActor
final class AgentManager: ObservableObject {

    @Published private(set) var sessions: [AgentSession] = []
    /// Sessions the compact pill represents: busy or waiting on the user. Shared
    /// by `syncPill` and the pill's per-session glyph strip so they can't disagree.
    var pillSessions: [AgentSession] {
        sessions.filter { $0.status.isBusy || $0.status == .needsAttention }
    }
    /// Account-wide Claude usage limits (when enabled), from the statusLine.
    @Published private(set) var usage: AgentUsage?
    /// Last enable/install failure, for the Settings UI. Cleared on the next
    /// successful toggle so stale errors don't linger.
    @Published private(set) var integrationError: String?
    @Published private(set) var permissionRequests: [String: PendingAgentPermission] = [:]

    private let activities: ActivityManager
    private let settings: Settings
    let notifier: AgentNotifier

    private let socketServer = AgentSocketServer()
    private let processLookup = ProcessLookup()
    private var providers: [AgentProviding] = []
    private var sessionsByKind: [AgentKind: [AgentSession]] = [:]
    private var permissionDeadlineTasks: [String: Task<Void, Never>] = [:]
    private var permissionCleanupTasks: [String: Task<Void, Never>] = [:]
    private var permissionApprovalCancellable: AnyCancellable?
    private var streamTask: Task<Void, Never>?
    private var streamGeneration = 0

    /// Last pill summary signature (count + status + project), so the pill only
    /// re-pops on a real change rather than every transcript write.
    private var pillSignature: String?

    /// Providers are configured once, but watching can be paused/resumed by the
    /// master switch without uninstalling any per-agent integration.
    private var isRunning = false

    init(activities: ActivityManager, settings: Settings) {
        self.activities = activities
        self.settings = settings
        self.notifier = AgentNotifier(activities: activities, settings: settings)
        self.permissionApprovalCancellable = settings.$agentPermissionApproval
            .dropFirst()
            .sink { [weak self] enabled in
                if !enabled { self?.disablePermissionResponses() }
            }
    }

    func start() {
        guard settings.agentsEnabled, !isRunning else { return }
        configureProvidersIfNeeded()
        isRunning = true

        providers.forEach { $0.start() }

        // Deliver envelopes through one serial stream instead of an independent
        // Task per envelope. Independent tasks have no ordering guarantee, so two
        // hooks fired back-to-back (e.g. PostToolUse then Stop) could be processed
        // reversed — leaving a session stuck "Thinking" after the turn finished.
        // A single consumer routes them in arrival order.
        streamGeneration += 1
        let generation = streamGeneration
        let (stream, continuation) = AsyncStream.makeStream(of: (HookEnvelope, pid_t).self)
        socketServer.start { [continuation] envelope, pid in
            continuation.yield((envelope, pid))
        } onPermissionTimeout: { [weak self] requestId in
            Task { @MainActor in
                guard let self, self.streamGeneration == generation else { return }
                self.permissionTimedOut(requestId)
            }
        }
        streamTask = Task { @MainActor [weak self] in
            for await (envelope, pid) in stream {
                guard let self, self.streamGeneration == generation else { return }
                self.route(envelope, pid: pid)
            }
        }

        let installer = AgentConfigInstaller()
        if settings.agentUsageLimits { try? installer.installClaudeUsage() }
    }

    /// Pause every provider and the shared socket while preserving the user's
    /// installed integrations. Re-enabling calls `start()` on the same providers.
    func stop() {
        guard isRunning else { return }
        isRunning = false
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        socketServer.stop()
        providers.forEach { $0.stop() }

        permissionDeadlineTasks.values.forEach { $0.cancel() }
        permissionDeadlineTasks = [:]
        permissionCleanupTasks.values.forEach { $0.cancel() }
        permissionCleanupTasks = [:]
        permissionRequests = [:]
        sessionsByKind = [:]
        sessions = []
        usage = nil
        syncPill()
    }

    /// The single entry point for both master switches so persisted state and the
    /// live subsystem can never disagree.
    func setWatchingEnabled(_ enabled: Bool) {
        settings.agentsEnabled = enabled
        if enabled { start() } else { stop() }
    }

    private func configureProvidersIfNeeded() {
        guard providers.isEmpty else { return }
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
            // t3 is a WebSocket client of the local t3 server, not a hook install.
            T3CodeProvider(settings: settings),
        ]
        for provider in providers {
            let kind = provider.kind
            provider.onSessions = { [weak self] sessions in
                self?.updateSessions(sessions, for: kind)
            }
            provider.onEvent = { [weak self] event in
                guard let self, self.isRunning else { return }
                self.notifier.notify(event)
            }
        }
        // Surface t3 protocol drift in the Settings footer; clearing only
        // removes a drift report, never an unrelated enable error.
        if let t3 = providers.compactMap({ $0 as? T3CodeProvider }).first {
            t3.onDrift = { [weak self] message in
                guard let self else { return }
                if let message {
                    self.integrationError = message
                } else if self.integrationError?.hasPrefix("T3 Code protocol") == true {
                    self.integrationError = nil
                }
            }
        }
    }


    /// Opt-in: wrap (or unwrap) Claude's statusLine to surface usage limits.
    func setUsageLimits(_ enabled: Bool) {
        let installer = AgentConfigInstaller()
        integrationError = nil
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
            integrationError = "Couldn't update Claude usage limits: \(error.localizedDescription)"
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

    func jumpToTerminal(_ pending: PendingAgentPermission) {
        TerminalJumper(processLookup: processLookup)
            .jump(toPID: pending.pid, cwd: pending.cwd)
    }

    /// Pull fresh state now — used when the Agents tab appears.
    func refresh() {
        guard isRunning else { return }
        providers.forEach { $0.refresh() }
    }

    func isEnabled(_ kind: AgentKind) -> Bool { provider(for: kind)?.isEnabled ?? false }


    func setEnabled(_ enabled: Bool, for kind: AgentKind) {
        guard let provider = provider(for: kind) else { return }
        objectWillChange.send()
        integrationError = nil
        if enabled {
            do {
                try provider.enable()
            } catch {
                integrationError = "Couldn't enable \(kind.displayName): \(error.localizedDescription)"
            }
        } else {
            provider.disable()
        }
    }

    /// Pair with a local t3 server from a `t3 pair` link (the t3 row's opt-in;
    /// pairing is async, so it can't ride the sync `enable()` path).
    func pairT3(link: String) async {
        guard let provider = provider(for: .t3code) as? T3CodeProvider else { return }
        integrationError = nil
        do {
            try await provider.pair(link: link)
            objectWillChange.send()
        } catch {
            integrationError = "Couldn't connect to T3 Code: \(error.localizedDescription)"
        }
    }

    // MARK: - Routing & reconciliation

    private func route(_ envelope: HookEnvelope, pid: pid_t) {
        guard isRunning else { return }
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
        if envelope.hook == "PermissionRequest", let requestId = envelope.requestId,
           !AgentFeatures.permissionApproval {
            // Approval is switched off build-wide: release the blocked hook at
            // once so the agent falls back to its own terminal prompt, and skip
            // the card bookkeeping entirely.
            if kind == .claudeCode {
                socketServer.respond(requestId: requestId, decision: "ask")
            }
        } else if envelope.hook == "PermissionRequest", let requestId = envelope.requestId {
            let request = AgentPermissionWireValidator.validated(
                envelope.permission, matchingRequestId: requestId
            )
            let receivedAt = Date()
            let canRespond = kind == .claudeCode && settings.agentPermissionApproval
            let deadline = min(request?.replyDeadline ?? receivedAt.addingTimeInterval(120),
                               receivedAt.addingTimeInterval(120))
            let risk = request.map {
                PermissionRiskClassifier.classify(request: $0, cwd: envelope.cwd)
            } ?? AgentPermissionRisk(level: .unknown, reasons: [.missingEvidence])
            permissionRequests[requestId] = PendingAgentPermission(
                id: requestId,
                kind: kind, sessionId: envelope.sessionId, cwd: envelope.cwd, pid: pid,
                request: request,
                risk: risk, receivedAt: receivedAt, replyDeadline: deadline,
                canRespond: canRespond, state: canRespond ? .pending : .expired
            )
            if canRespond {
                schedulePermissionDeadline(requestId, deadline: deadline)
            } else {
                if kind == .claudeCode {
                    socketServer.respond(requestId: requestId, decision: "ask")
                }
                schedulePermissionCleanup(requestId, after: 12)
            }
        }
        provider(for: kind)?.ingest(envelope, pid: pid)
    }

    /// Answer a session's pending permission request from the notch. On delivery,
    /// feed a synthetic hook so the row leaves needs-attention at once instead of
    /// waiting for Claude's next real hook.
    func respondToPermission(_ session: AgentSession, allow: Bool) {
        guard let requestId = session.permissionRequestId else { return }
        respondToPermission(requestId: requestId, decision: allow ? .allow : .deny)
    }

    func respondToPermission(requestId: String, decision: AgentPermissionDecision) {
        guard AgentFeatures.permissionApproval,
              settings.agentPermissionApproval,
              var pending = permissionRequests[requestId],
              let next = AgentPermissionStateMachine.transition(
                from: pending.state, event: .respond(decision)
              ) else { return }
        pending.state = next
        permissionRequests[requestId] = pending
        permissionDeadlineTasks[requestId]?.cancel()
        permissionDeadlineTasks[requestId] = nil
        let generation = streamGeneration
        socketServer.respond(requestId: requestId, decision: decision.rawValue) { [weak self] delivered in
            Task { @MainActor in
                guard let self, self.isRunning,
                      self.streamGeneration == generation else { return }
                guard var current = self.permissionRequests[requestId] else { return }
                if delivered {
                    guard let state = AgentPermissionStateMachine.transition(
                        from: current.state, event: .delivered
                    ) else { return }
                    current.state = state
                    self.permissionRequests[requestId] = current
                    if let sessionId = current.sessionId {
                        self.provider(for: current.kind)?.ingest(HookEnvelope(
                            agent: current.kind.rawValue, hook: "PermissionResolved",
                            sessionId: sessionId, cwd: current.cwd, pid: current.pid
                        ), pid: current.pid)
                    }
                    self.schedulePermissionCleanup(requestId, after: 3)
                } else {
                    guard let state = AgentPermissionStateMachine.transition(
                        from: current.state, event: .deliveryFailed
                    ) else { return }
                    current.state = state
                    self.permissionRequests[requestId] = current
                    self.publishPermissionTimeout(current)
                    self.schedulePermissionCleanup(requestId, after: 5)
                }
            }
        }
    }

    private func permissionTimedOut(_ requestId: String) {
        guard isRunning, var pending = permissionRequests[requestId],
              let state = AgentPermissionStateMachine.transition(
                from: pending.state, event: .expire
              ) else { return }
        pending.state = state
        permissionRequests[requestId] = pending
        publishPermissionTimeout(pending)
        schedulePermissionCleanup(requestId, after: 8)
    }

    private func publishPermissionTimeout(_ pending: PendingAgentPermission) {
        guard let sessionId = pending.sessionId else { return }
        provider(for: pending.kind)?.ingest(HookEnvelope(
            agent: pending.kind.rawValue, hook: "PermissionTimedOut", sessionId: sessionId,
            cwd: pending.cwd, pid: pending.pid
        ), pid: pending.pid)
    }

    private func schedulePermissionDeadline(_ requestId: String, deadline: Date) {
        permissionDeadlineTasks[requestId]?.cancel()
        permissionDeadlineTasks[requestId] = Task { @MainActor [weak self] in
            let delay = max(0, deadline.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.socketServer.respond(requestId: requestId, decision: "ask")
            self.permissionTimedOut(requestId)
            self.permissionDeadlineTasks[requestId] = nil
        }
    }

    private func schedulePermissionCleanup(_ requestId: String, after delay: TimeInterval) {
        permissionCleanupTasks[requestId]?.cancel()
        permissionCleanupTasks[requestId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.permissionRequests[requestId] = nil
            self.permissionCleanupTasks[requestId] = nil
        }
    }

    private func disablePermissionResponses() {
        let pendingIds = permissionRequests.compactMap { $0.value.state == .pending ? $0.key : nil }
        for requestId in pendingIds {
            guard var pending = permissionRequests[requestId] else { continue }
            if pending.kind == .claudeCode {
                socketServer.respond(requestId: requestId, decision: "ask")
            }
            pending.state = .expired
            permissionRequests[requestId] = pending
            permissionDeadlineTasks[requestId]?.cancel()
            permissionDeadlineTasks[requestId] = nil
            schedulePermissionCleanup(requestId, after: 8)
        }
    }

    func copyPermissionSummary(_ pending: PendingAgentPermission, session: AgentSession?) {
        let summary = AgentPermissionAuditSummary.make(pending: pending, session: session)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(summary, forType: .string)
    }

    private func updateSessions(_ sessions: [AgentSession], for kind: AgentKind) {
        guard isRunning else { return }
        sessionsByKind[kind] = sessions
        let merged = AgentKind.allCases
            .flatMap { sessionsByKind[$0] ?? [] }
            .sorted { $0.lastActivity > $1.lastActivity }
        self.sessions = merged
        syncPill()
    }

    /// Mirror the active agents into the pill as one aggregate entry showing the
    /// running count + the most important status (idle ones live in the Agents
    /// tab). Only re-publish when that summary actually changes.
    private func syncPill() {
        let active = pillSessions
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
