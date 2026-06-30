import AppKit
import Foundation

/// Watches Claude Code sessions. Lifecycle/attention come from opt-in
/// fire-and-forget hooks (Notification / Stop / SessionStart / SessionEnd) over
/// the socket; fine-grained activity (editing / tool / running), the working
/// dir, git branch, and liveness come from tailing `~/.claude/projects/**/*.jsonl`
/// and matching live `claude` pids by cwd. No timers — every refresh is triggered
/// by a socket event, an FSEvents change, or app activation.
///
/// This type only orchestrates: it owns the watch/reconcile lifecycle and the
/// hook-state bookkeeping, then delegates the work to three focused modules —
/// `ProcessScanner` (libproc), `TranscriptParser` (bytes → state), and the pure
/// `StatusReducer` ((hook, scan) → status).
@MainActor
final class ClaudeCodeProvider: AgentProviding {

    let kind: AgentKind = .claudeCode

    var onSessions: (([AgentSession]) -> Void)?
    var onEvent: ((AgentEvent) -> Void)?

    private let settings: Settings
    private let installer = AgentConfigInstaller()
    private let processLookup: ProcessLookup
    private let watcher = DirectoryWatcher(path: ProcessScanner.projectsRoot.path)

    private var sessionsByID: [String: AgentSession] = [:]
    private var hookState: [String: HookSnapshot] = [:]
    private var hookCwd: [String: String] = [:]
    private var endedSessionIDs: Set<String> = []
    private var lastScan: [ScannedSession] = []
    private var reconcileTask: Task<Void, Never>?
    private var reconcilePending = false
    private var livenessTask: Task<Void, Never>?
    private var reconcileGeneration = 0
    /// Last attention-hook time we surfaced per session, so a fresh permission
    /// prompt re-notifies even when the status is already `.needsAttention`.
    private var emittedAttentionAt: [String: Date] = [:]
    private var activationObserver: NSObjectProtocol?

    /// A hook-only session (seen via hook, not yet by the process scan) is kept
    /// this long before being purged as a dead/crashed session that never sent
    /// SessionEnd.
    private static let graceWindow: TimeInterval = 30
    /// While a turn is in progress, re-run reconcile on this cadence so a process
    /// that exits mid-turn (no final transcript write or hook) is still dropped
    /// promptly. Busy-vs-idle itself is structural, so this never flaps the status.
    private static let livenessRecheck: TimeInterval = 8

    init(processLookup: ProcessLookup, settings: Settings) {
        self.processLookup = processLookup
        self.settings = settings
    }

    var isEnabled: Bool { settings.agentClaudeEnabled }

    // MARK: - Lifecycle

    func start() {
        guard isEnabled else { return }
        // Keep the stable-path launcher current (cheap, local). The config points
        // at that launcher, so it only needs rewriting if it went missing.
        try? installer.writeBridge()
        // Install if missing, or upgrade a legacy app-path hook to the launcher.
        if !installer.claudeBridgeInstalled() {
            try? installer.installClaudeHooks()
        }
        beginWatching()
    }

    func stop() {
        reconcileTask?.cancel()
        reconcileTask = nil
        reconcilePending = false
        livenessTask?.cancel()
        livenessTask = nil
        watcher.stop()
        if let activationObserver {
            NotificationCenter.default.removeObserver(activationObserver)
            self.activationObserver = nil
        }
    }

    func enable() {
        do {
            try installer.installClaudeHooks()
            settings.agentClaudeEnabled = true
            Log.agents.info("Claude hooks installed")
            beginWatching()
        } catch {
            // Don't claim "enabled" if we couldn't write the hooks — leave the
            // flag off so the UI keeps showing the Enable affordance.
            settings.agentClaudeEnabled = false
            Log.agents.error("Claude hook install failed: \(String(describing: error))")
        }
    }

    func disable() {
        settings.agentClaudeEnabled = false
        do {
            try installer.removeClaudeHooks()
            Log.agents.info("Claude hooks removed")
        } catch {
            Log.agents.error("Claude hook removal failed: \(String(describing: error))")
        }
        stop()
        sessionsByID = [:]
        hookState = [:]
        hookCwd = [:]
        endedSessionIDs = []
        emittedAttentionAt = [:]
        lastScan = []
        onSessions?([])
    }

    private func beginWatching() {
        watcher.start { [weak self] _ in
            Task { @MainActor in self?.scheduleReconcile() }
        }
        if activationObserver == nil {
            activationObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.scheduleReconcile() }
            }
        }
        // Reconcile immediately so enabling (or launch) surfaces live sessions at
        // once instead of after the first debounce window.
        Task { [weak self] in await self?.reconcile() }
    }

    func refresh() {
        guard isEnabled else { return }
        Task { [weak self] in await self?.reconcile() }
    }

    // MARK: - Socket events

    func ingest(_ envelope: HookEnvelope, pid: pid_t) {
        guard let sid = envelope.sessionId else { scheduleReconcile(); return }
        if let cwd = envelope.cwd { hookCwd[sid] = cwd }
        if envelope.hook == "SessionEnd" {
            // Tombstone the session for removal, and drop its hook state so it
            // can't be resurrected on a later rebuild.
            endedSessionIDs.insert(sid)
            hookState[sid] = nil
        } else {
            endedSessionIDs.remove(sid)
            hookState[sid] = HookSnapshot(name: envelope.hook, time: Date(), message: envelope.message, tool: envelope.tool)
        }
        rebuild()
        scheduleReconcile() // fill pid / branch / liveness
    }

    // MARK: - Reconcile

    /// Coalesce a burst of events into one reconcile ~200ms after the *first*
    /// event, rather than cancelling and rescheduling on each. A trailing-only
    /// debounce starves during sustained transcript writes (every write resets
    /// the timer), which left status lagging while an agent was actively working.
    private func scheduleReconcile() {
        guard !reconcilePending else { return }
        reconcilePending = true
        reconcileTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard let self else { return }
            self.reconcilePending = false
            guard !Task.isCancelled else { return }
            await self.reconcile()
        }
    }

    private func reconcile() async {
        reconcileGeneration += 1
        let generation = reconcileGeneration
        let scanner = ProcessScanner(lookup: processLookup)
        let scan = await Task.detached(priority: .utility) {
            scanner.scan()
        }.value
        // A newer reconcile started while this scan ran (Task.detached doesn't
        // inherit cancellation): drop this stale result so it can't clobber it.
        guard generation == reconcileGeneration else { return }
        lastScan = scan
        rebuild()
    }

    /// Merge the latest process/transcript scan with hook state into the session
    /// set, compute each status, emit transitions, and publish.
    private func rebuild() {
        var result: [String: AgentSession] = [:]

        for scanned in lastScan where !endedSessionIDs.contains(scanned.sessionId) {
            result[scanned.sessionId] = AgentSession(
                id: scanned.sessionId, kind: .claudeCode, project: agentProjectName(scanned.cwd),
                cwd: scanned.cwd, status: .idle, startedAt: scanned.lastActivity,
                lastActivity: scanned.lastActivity, pid: scanned.pid, gitBranch: scanned.gitBranch,
                terminalFocusURL: scanned.focusURL, lastPrompt: scanned.prompt,
                lastResponse: scanned.response, terminalName: scanned.terminalName
            )
        }

        // Hook-known sessions not yet seen by the scan. Keep one only briefly:
        // a real session shows up in the scan within a reconcile or two, so a
        // hook with no matching live process past the grace window is a crashed
        // session that never sent SessionEnd — purge it instead of resurrecting
        // a phantom (e.g. a stuck "needs you") on every rebuild.
        let now = Date()
        for sid in Array(hookState.keys) where result[sid] == nil {
            if endedSessionIDs.contains(sid) { continue }
            guard let hook = hookState[sid], let cwd = hookCwd[sid] else { continue }
            if now.timeIntervalSince(hook.time) <= Self.graceWindow {
                result[sid] = AgentSession(
                    id: sid, kind: .claudeCode, project: agentProjectName(cwd), cwd: cwd,
                    status: .idle, startedAt: hook.time, lastActivity: hook.time,
                    pid: nil, gitBranch: nil, detail: hook.message
                )
            } else {
                hookState[sid] = nil
                hookCwd[sid] = nil
                emittedAttentionAt[sid] = nil
            }
        }

        for sid in Array(result.keys) {
            var session = result[sid]!
            let scanned = lastScan.first { $0.sessionId == sid }
            let resolved = StatusReducer.reduce(hook: hookState[sid], scan: scanned.map(Self.scanInput))
            session.status = resolved.status
            session.activityVerb = resolved.status.isBusy ? resolved.verb : nil
            session.detail = hookState[sid]?.message ?? session.detail
            if let prev = sessionsByID[sid] {
                session.startedAt = prev.startedAt
                // Keep previously-captured detail if this cycle didn't see it.
                session.terminalFocusURL = session.terminalFocusURL ?? prev.terminalFocusURL
                session.terminalName = session.terminalName ?? prev.terminalName
                session.lastPrompt = session.lastPrompt ?? prev.lastPrompt
                session.lastResponse = session.lastResponse ?? prev.lastResponse
            }
            result[sid] = session
        }

        emitEvents(old: sessionsByID, new: result)
        sessionsByID = result
        onSessions?(Array(result.values))

        // A SessionEnd tombstone is only needed while the process is still winding
        // down in the scan; once it's gone, forget it so the set stays bounded.
        endedSessionIDs.formIntersection(Set(lastScan.map(\.sessionId)))
        // Reconcile is event-driven; while a turn is in progress also re-check on a
        // timer so a process that exits mid-turn (without a final write or hook) is
        // dropped promptly. Re-checking a still-running turn just re-confirms busy —
        // status is structural now, so this never flaps it to idle. Stops once idle.
        scheduleLivenessRecheck(busy: result.values.contains { $0.status.isBusy })
    }

    private func scheduleLivenessRecheck(busy: Bool) {
        livenessTask?.cancel()
        guard busy else { livenessTask = nil; return }
        livenessTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.livenessRecheck))
            guard !Task.isCancelled, let self else { return }
            await self.reconcile()
        }
    }

    /// Project a scanned session onto just the facts the status reducer needs.
    private static func scanInput(_ scanned: ScannedSession) -> StatusReducer.Scan {
        StatusReducer.Scan(lastActivity: scanned.lastActivity, busy: scanned.busyStatus, verb: scanned.verb)
    }

    private func emitEvents(old: [String: AgentSession], new: [String: AgentSession]) {
        for (sid, session) in new {
            // A fresh permission prompt surfaces even when the status was already
            // needsAttention (two prompts in a row share the status). Keyed on the
            // Notification hook time so each distinct prompt fires exactly once.
            if session.status == .needsAttention,
               let attentionTime = hookState[sid].flatMap({ $0.name == "Notification" ? $0.time : nil }) {
                if emittedAttentionAt[sid] != attentionTime {
                    emittedAttentionAt[sid] = attentionTime
                    onEvent?(AgentEvent(kind: .needsAttention, session: session, message: session.detail))
                }
                continue
            }

            guard let previous = old[sid] else {
                // Only a genuine SessionStart hook announces a start; sessions that
                // predate the app/enable are discovered silently by the scan.
                if hookState[sid]?.name == "SessionStart" {
                    onEvent?(AgentEvent(kind: .started, session: session, message: nil))
                }
                continue
            }

            if previous.status != session.status, session.status == .finished {
                onEvent?(AgentEvent(kind: .finished, session: session, message: nil))
            }
        }
        for (sid, session) in old where new[sid] == nil {
            emittedAttentionAt[sid] = nil
            onEvent?(AgentEvent(kind: .ended, session: session, message: nil))
        }
    }
}
