import AppKit
import Foundation

/// Watches Claude Code sessions. Lifecycle/attention come from opt-in
/// fire-and-forget hooks (Notification / Stop / SessionStart / SessionEnd) over
/// the socket; fine-grained activity (editing / tool / running), the working
/// dir, git branch, and liveness come from tailing `~/.claude/projects/**/*.jsonl`
/// and matching live `claude` pids by cwd. No timers — every refresh is triggered
/// by a socket event, an FSEvents change, or app activation.
@MainActor
final class ClaudeCodeProvider: AgentProviding {

    let kind: AgentKind = .claudeCode
    let capabilities: AgentProviderCapabilities = [.liveEvents, .attention]

    var onSessions: (([AgentSession]) -> Void)?
    var onEvent: ((AgentEvent) -> Void)?

    private let settings: Settings
    private let installer = AgentConfigInstaller()
    private let processLookup: ProcessLookup
    private let watcher = DirectoryWatcher(path: ClaudeCodeProvider.projectsRoot.path)

    private var sessionsByID: [String: AgentSession] = [:]
    private var hookState: [String: (name: String, time: Date, message: String?)] = [:]
    private var hookCwd: [String: String] = [:]
    private var endedSessionIDs: Set<String> = []
    private var lastScan: [ScannedSession] = []
    private var reconcileTask: Task<Void, Never>?
    private var reconcilePending = false
    private var decayTask: Task<Void, Never>?
    private var reconcileGeneration = 0
    /// Last attention-hook time we surfaced per session, so a fresh permission
    /// prompt re-notifies even when the status is already `.needsAttention`.
    private var emittedAttentionAt: [String: Date] = [:]
    private var activationObserver: NSObjectProtocol?

    /// A hook-only session (seen via hook, not yet by the process scan) is kept
    /// this long before being purged as a dead/crashed session that never sent
    /// SessionEnd. Also the window after which a transcript-derived busy status
    /// decays to idle.
    private static let graceWindow: TimeInterval = 30
    private static let busyWindow: TimeInterval = 8

    init(processLookup: ProcessLookup, settings: Settings) {
        self.processLookup = processLookup
        self.settings = settings
    }

    var isEnabled: Bool { settings.agentClaudeEnabled }

    // MARK: - Lifecycle

    func start() {
        guard isEnabled else { return }
        // Self-heal the hook command path in case the app moved since last install.
        try? installer.installClaudeHooks()
        beginWatching()
    }

    func stop() {
        reconcileTask?.cancel()
        reconcileTask = nil
        reconcilePending = false
        decayTask?.cancel()
        decayTask = nil
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
            hookState[sid] = (envelope.hook, Date(), envelope.message)
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
        let lookup = processLookup
        let scan = await Task.detached(priority: .utility) {
            Self.scanLiveSessions(lookup: lookup)
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
                id: scanned.sessionId, kind: .claudeCode, project: Self.projectName(scanned.cwd),
                cwd: scanned.cwd, status: .idle, startedAt: scanned.lastActivity,
                lastActivity: scanned.lastActivity, pid: scanned.pid, gitBranch: scanned.gitBranch,
                terminalFocusURL: scanned.focusURL
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
                    id: sid, kind: .claudeCode, project: Self.projectName(cwd), cwd: cwd,
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
            session.status = computeStatus(sid: sid, scanned: lastScan.first { $0.sessionId == sid })
            session.detail = hookState[sid]?.message ?? session.detail
            if let prev = sessionsByID[sid] {
                session.startedAt = prev.startedAt
                // Keep a previously-captured focus URL if this cycle didn't see one.
                session.terminalFocusURL = session.terminalFocusURL ?? prev.terminalFocusURL
            }
            result[sid] = session
        }

        emitEvents(old: sessionsByID, new: result)
        sessionsByID = result
        onSessions?(Array(result.values))

        // A SessionEnd tombstone is only needed while the process is still winding
        // down in the scan; once it's gone, forget it so the set stays bounded.
        endedSessionIDs.formIntersection(Set(lastScan.map(\.sessionId)))
        // Transcript-derived busy decays to idle on a wall clock, but reconcile is
        // event-driven; schedule a one-shot re-check so a finished-but-Stop-less
        // turn doesn't sit "running" forever. Stops rescheduling once idle.
        scheduleDecay(needed: result.values.contains { $0.status.isBusy })
    }

    private func scheduleDecay(needed: Bool) {
        decayTask?.cancel()
        guard needed else { decayTask = nil; return }
        decayTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.busyWindow + 0.5))
            guard !Task.isCancelled, let self else { return }
            await self.reconcile()
        }
    }

    private func computeStatus(sid: String, scanned: ScannedSession?) -> AgentStatus {
        let hook = hookState[sid]
        let fileTime = scanned?.lastActivity ?? .distantPast

        if let hook, hook.time >= fileTime {
            switch hook.name {
            case "Notification":
                // Claude's Notification hook covers both permission prompts and
                // idle "waiting for your input" nudges. Only a permission prompt is
                // a real needs-you; an idle nudge fires with no follow-up activity,
                // so treating it as attention left finished/idle sessions stuck
                // showing "needs you". A genuine prompt clears on its own once the
                // user answers and the transcript advances past the hook time.
                if !Self.isIdleNotification(hook.message) { return .needsAttention }
            case "Stop", "SessionEnd": return .finished
            case "SessionStart": return scanned?.busyStatus ?? .running
            default: break
            }
        }

        guard scanned != nil else { return .idle }
        // The transcript is the freshest signal: treat very recent writes as busy,
        // otherwise the session is alive but waiting.
        return Date().timeIntervalSince(fileTime) < Self.busyWindow ? (scanned?.busyStatus ?? .running) : .idle
    }

    /// Distinguish Claude's idle "waiting for your input" Notification from a
    /// permission prompt, so the former doesn't read as needs-you.
    nonisolated private static func isIdleNotification(_ message: String?) -> Bool {
        guard let message = message?.lowercased() else { return false }
        return message.contains("waiting") || message.contains("idle")
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

    // MARK: - Off-main scan

    private struct ScannedSession: Sendable {
        let sessionId: String
        let cwd: String
        let pid: pid_t
        let lastActivity: Date
        let gitBranch: String?
        let busyStatus: AgentStatus
        let focusURL: String?
    }

    nonisolated private static let projectsRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/projects", isDirectory: true)

    nonisolated private static let editTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

    // Known limitation: two `claude` processes in the SAME directory collapse to
    // one scanned session (the newest transcript), since cwd is the only link
    // between a pid and a session without inspecting each process's open files.
    // Distinct hook sessions still surface separately via hookState.
    /// The `claude` CLI's executable is the versioned binary
    /// (`…/claude/versions/X.Y.Z`), so `proc_name` is the version string, not
    /// "claude" — matching by name finds nothing. Match by executable path, and
    /// fall back to argv for a runtime-hosted CLI (`node …/claude-code/…`).
    nonisolated private static func isClaudeProcess(_ pid: pid_t, lookup: ProcessLookup) -> Bool {
        guard let path = lookup.path(of: pid) else { return false }
        let lower = path.lowercased()
        if lower.contains("/claude/") || lower.contains("/claude-code") { return true }
        let base = (path as NSString).lastPathComponent
        if base == "claude" { return true }
        if base == "node" || base == "bun" || base == "deno" {
            return lookup.arguments(of: pid).contains { $0.lowercased().contains("claude") }
        }
        return false
    }

    nonisolated private static func scanLiveSessions(lookup: ProcessLookup) -> [ScannedSession] {
        var result: [ScannedSession] = []
        var seenCwd = Set<String>()
        for pid in lookup.allPIDs() where isClaudeProcess(pid, lookup: lookup) {
            guard let cwd = lookup.cwd(of: pid), !seenCwd.contains(cwd) else { continue }
            seenCwd.insert(cwd)
            guard let transcript = newestTranscript(forCwd: cwd) else { continue }
            result.append(ScannedSession(
                sessionId: transcript.sessionId, cwd: cwd, pid: pid,
                lastActivity: transcript.mtime, gitBranch: transcript.branch, busyStatus: transcript.busy,
                focusURL: terminalFocusURL(forPID: pid, lookup: lookup)
            ))
        }
        return result
    }

    /// A deep link to the exact hosting tab, read from the agent process's
    /// environment. Warp exports `WARP_FOCUS_URL` (warp://session/<uuid>) per tab;
    /// otherwise reconstruct it from the session UUID.
    nonisolated private static func terminalFocusURL(forPID pid: pid_t, lookup: ProcessLookup) -> String? {
        let env = lookup.environment(of: pid)
        if let url = env["WARP_FOCUS_URL"], !url.isEmpty { return url }
        if let uuid = env["WARP_TERMINAL_SESSION_UUID"], !uuid.isEmpty { return "warp://session/\(uuid)" }
        return nil
    }

    nonisolated private static func newestTranscript(
        forCwd cwd: String
    ) -> (sessionId: String, mtime: Date, branch: String?, busy: AgentStatus)? {
        let encoded = cwd.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ".", with: "-")
        let dir = projectsRoot.appendingPathComponent(encoded, isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
        ) else { return nil }
        let jsonls = entries.filter { $0.pathExtension == "jsonl" }
        guard let newest = jsonls.max(by: { mtime($0) < mtime($1) }) else { return nil }
        let (branch, busy) = parseTail(newest)
        return (newest.deletingPathExtension().lastPathComponent, mtime(newest), branch, busy)
    }

    nonisolated private static func parseTail(_ url: URL) -> (String?, AgentStatus) {
        guard let chunk = readTail(url, maxBytes: 16384) else { return (nil, .running) }
        var branch: String?
        var status: AgentStatus = .running
        var foundStatus = false
        for line in chunk.split(separator: 0x0A).reversed() {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            if branch == nil { branch = obj["gitBranch"] as? String }
            if !foundStatus {
                switch obj["type"] as? String {
                case "assistant":
                    if let message = obj["message"] as? [String: Any],
                       let content = message["content"] as? [[String: Any]] {
                        if let tool = content.last(where: { ($0["type"] as? String) == "tool_use" }),
                           let name = tool["name"] as? String {
                            status = editTools.contains(name) ? .editing : .tool
                        } else {
                            status = .running
                        }
                        foundStatus = true
                    }
                case "user":
                    status = .running
                    foundStatus = true
                default:
                    break
                }
            }
            if branch != nil && foundStatus { break }
        }
        return (branch, status)
    }

    nonisolated private static func readTail(_ url: URL, maxBytes: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        try? handle.seek(toOffset: start)
        guard var data = try? handle.readToEnd() else { return nil }
        // Drop the leading partial line when we seeked into the middle of one.
        if start > 0, let newline = data.firstIndex(of: 0x0A) {
            data = data.subdata(in: data.index(after: newline)..<data.endIndex)
        }
        return data
    }

    nonisolated private static func mtime(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    nonisolated private static func projectName(_ cwd: String) -> String {
        cwd.isEmpty ? "—" : (cwd as NSString).lastPathComponent
    }
}
