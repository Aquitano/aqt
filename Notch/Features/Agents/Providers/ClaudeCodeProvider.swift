import AppKit
import NotchCore
import Foundation

/// Watches Claude Code sessions. Every session is announced by its own hooks:
/// the envelope carries the session id, the agent's pid and the transcript it
/// writes, which is recorded as an `AgentSessionBinding`. From then on a session
/// exists exactly as long as that process does, and its status comes from its
/// own transcript plus the latest hook — nothing is matched by directory or file
/// timing. No timers either: every refresh is triggered by a socket event, an
/// FSEvents change, or app activation.
///
/// Bindings are persisted, because hooks announce a session once rather than on
/// a schedule: without that, restarting the app would empty the list until every
/// session happened to act again.
///
/// This type only orchestrates: it owns the watch/reconcile lifecycle and the
/// hook/binding bookkeeping, then delegates the work to three focused modules —
/// `SessionProbe` (liveness + transcript read), `TranscriptParser` (bytes →
/// state), and the pure `StatusReducer` ((hook, scan) → status).
@MainActor
final class ClaudeCodeProvider: AgentProviding {

    let kind: AgentKind = .claudeCode

    var onSessions: (([AgentSession]) -> Void)?
    var onEvent: ((AgentEvent) -> Void)?

    private let settings: Settings
    private let installer = AgentConfigInstaller()
    private let processLookup: ProcessLookup
    private let watcher = DirectoryWatcher(path: SessionProbe.projectsRoot.path)
    private let persistence: Persistence
    private let diagnostics: Diagnostics
    private static let bindingsFile = "claude-sessions.json"

    private var sessionsByID: [String: AgentSession] = [:]
    private var bindings: [String: AgentSessionBinding] = [:]
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

    init(processLookup: ProcessLookup, settings: Settings, persistence: Persistence, diagnostics: Diagnostics) {
        self.processLookup = processLookup
        self.settings = settings
        self.persistence = persistence
        self.diagnostics = diagnostics
    }

    var isEnabled: Bool { settings.agents.claudeEnabled }

    // MARK: - Lifecycle

    func start() {
        guard isEnabled else { return }
        do {
            // Keep the stable-path launcher current (cheap, local). The config points
            // at that launcher, so it only needs rewriting if it went missing.
            try installer.writeBridge()
            // Install if missing, or upgrade a legacy app-path hook to the launcher.
            if !installer.claudeBridgeInstalled() {
                try installer.installClaudeHooks()
            }
        } catch {
            diagnostics.report(source: "Claude Code hooks", error)
        }
        // Sessions announced while we were not running are still out there; the
        // first reconcile drops whichever of them have since exited.
        do {
            bindings = (try persistence.load([AgentSessionBinding].self, from: Self.bindingsFile) ?? [])
                .reduce(into: [:]) { $0[$1.sessionId] = $1 }
        } catch {
            diagnostics.report(source: "Claude Code sessions", error)
            bindings = [:]
        }
        beginWatching()
    }

    func stop() {
        // Invalidate any in-flight reconcile: its scan runs on a detached task that
        // doesn't inherit cancellation, so without bumping the generation it would
        // publish scanned sessions after disable() already sent onSessions([]).
        reconcileGeneration += 1
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
        sessionsByID = [:]
        hookState = [:]
        hookCwd = [:]
        endedSessionIDs = []
        emittedAttentionAt = [:]
        lastScan = []
        // Bindings survive a stop: pausing the watch (or quitting the app) must
        // not forget sessions that are still running. `disable()` clears them.
        bindings = [:]
        onSessions?([])
    }

    func enable() throws {
        do {
            try installer.installClaudeHooks()
            settings.agents.claudeEnabled = true
            Log.agents.info("Claude hooks installed")
            beginWatching()
        } catch {
            // Don't claim "enabled" if we couldn't write the hooks — leave the
            // flag off so the UI keeps showing the Enable affordance.
            settings.agents.claudeEnabled = false
            Log.agents.error("Claude hook install failed: \(String(describing: error))")
            throw error
        }
    }

    func disable() {
        settings.agents.claudeEnabled = false
        persistence.removeFile(named: Self.bindingsFile)
        do {
            try installer.removeClaudeHooks()
            Log.agents.info("Claude hooks removed")
        } catch {
            Log.agents.error("Claude hook removal failed: \(String(describing: error))")
        }
        stop()
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
        // A still-running claude keeps its hooks loaded after the user toggles the
        // integration off; without this guard its envelopes resurrect sessions
        // while the feature is disabled.
        guard isEnabled else { return }
        guard let sid = envelope.sessionId else { scheduleReconcile(); return }
        if let cwd = envelope.cwd { hookCwd[sid] = cwd }
        bind(envelope, to: sid)
        if envelope.hook == "SessionEnd" {
            // Tombstone the session for removal, and drop its hook state so it
            // can't be resurrected on a later rebuild. Also drop hookCwd: the
            // reconciler derives expiredHookIDs from hookState.keys, so a cwd left
            // behind here (this branch is reached with a cwd via the write above)
            // could never be expired and would leak one entry per session.
            endedSessionIDs.insert(sid)
            hookState[sid] = nil
            hookCwd[sid] = nil
            if bindings.removeValue(forKey: sid) != nil { persistBindings() }
        } else {
            endedSessionIDs.remove(sid)
            hookState[sid] = HookSnapshot(
                name: envelope.hook, time: Date(), message: envelope.message,
                tool: envelope.tool, requestId: envelope.requestId,
                notificationType: envelope.notificationType
            )
        }
        rebuild()
        scheduleReconcile() // fill pid / branch / liveness
    }

    // MARK: - Bindings

    /// Record what this hook says the session is. Only the identity is taken
    /// here — the terminal details need the agent's environment and, for a herdr
    /// pane, the `herdr` CLI, so `SessionProbe` fills those in off the main actor
    /// the first time it sees the binding.
    ///
    /// The pid is re-read on every hook rather than trusted once: `/clear` and
    /// `--continue` reuse a process across session ids, and a session id can
    /// outlive the process that first announced it.
    private func bind(_ envelope: HookEnvelope, to sid: String) {
        guard let pid = envelope.pid, pid > 0, let cwd = envelope.cwd else { return }
        // Notification payloads don't always carry the transcript path; keep the
        // one an earlier hook gave us rather than dropping the binding.
        guard let transcript = envelope.transcriptPath ?? bindings[sid]?.transcriptPath else { return }

        if var existing = bindings[sid], existing.pid == pid {
            guard existing.cwd != cwd || existing.transcriptPath != transcript else { return }
            // A session can move (`/add-dir`, a compaction writing on): keep the
            // identity, take the newer facts.
            existing.cwd = cwd
            existing.transcriptPath = transcript
            bindings[sid] = existing
            persistBindings()
            return
        }
        guard let startedAt = processLookup.startDate(of: pid) else { return }
        bindings[sid] = AgentSessionBinding(
            sessionId: sid, pid: pid, startedAt: startedAt.timeIntervalSince1970,
            cwd: cwd, transcriptPath: transcript
        )
        persistBindings()
    }

    /// Adopt what the probe found: it drops the bindings whose process is gone
    /// and fills in terminal details, but it worked from a snapshot, so a hook
    /// that landed while it ran keeps its (newer) binding.
    private func adopt(_ probed: [AgentSessionBinding], from snapshot: [AgentSessionBinding]) {
        let survivors = Set(probed.map(\.sessionId))
        for binding in snapshot where !survivors.contains(binding.sessionId) {
            if bindings[binding.sessionId]?.pid == binding.pid { bindings[binding.sessionId] = nil }
        }
        for binding in probed where bindings[binding.sessionId]?.pid == binding.pid {
            bindings[binding.sessionId] = binding
        }
        persistBindings()
    }

    private func persistBindings() {
        persistence.save(Array(bindings.values), to: Self.bindingsFile)
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
        guard isEnabled else { return }
        reconcileGeneration += 1
        let generation = reconcileGeneration
        let probe = SessionProbe(lookup: processLookup)
        let snapshot = Array(bindings.values)
        let result = await Task.detached(priority: .utility) {
            probe.probe(snapshot)
        }.value
        // A newer reconcile started while this probe ran, or the feature was disabled
        // (Task.detached doesn't inherit cancellation): drop this stale result so it
        // can't clobber the current state or re-publish after disable().
        guard isEnabled, generation == reconcileGeneration else { return }
        adopt(result.bindings, from: snapshot)
        lastScan = result.sessions
        rebuild()
    }

    /// Run the pure reconcile over the current scan + hook state, then apply its
    /// side effects: emit transitions, publish, and prune the local bookkeeping.
    private func rebuild() {
        let outcome = SessionReconciler.reconcile(SessionReconciler.Inputs(
            scan: lastScan, hookState: hookState, hookCwd: hookCwd,
            endedSessionIDs: endedSessionIDs, previous: sessionsByID,
            emittedAttentionAt: emittedAttentionAt, now: Date(), graceWindow: Self.graceWindow
        ))

        // Forget hook-only sessions that aged out past the grace window.
        for sid in outcome.expiredHookIDs {
            hookState[sid] = nil
            hookCwd[sid] = nil
        }
        emittedAttentionAt = outcome.emittedAttentionAt
        for event in outcome.events { onEvent?(event) }
        sessionsByID = outcome.sessions
        onSessions?(Array(outcome.sessions.values))

        // A SessionEnd tombstone is only needed while the process is still winding
        // down in the scan; once it's gone, forget it so the set stays bounded.
        endedSessionIDs.formIntersection(Set(lastScan.map(\.sessionId)))
        // Reconcile is event-driven; while a turn is in progress also re-check on a
        // timer so a process that exits mid-turn (without a final write or hook) is
        // dropped promptly. Re-checking a still-running turn just re-confirms busy —
        // status is structural now, so this never flaps it to idle. Stops once idle.
        scheduleLivenessRecheck(busy: outcome.sessions.values.contains { $0.status.isBusy })
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
}
