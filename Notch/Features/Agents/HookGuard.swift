import Foundation

/// Puts our Claude hooks back when another tool (a dotfiles sync, a config
/// manager, a hand edit) removes or overwrites them, and tells the user it
/// happened.
///
/// The check is "are our hooks still fully installed", so our own writes need no
/// suppression flag: they leave the hooks intact and the event is a no-op.
/// Repairs are throttled by `HookRestorePolicy` — see there for the rules.
@MainActor
final class HookGuard {

    private let installer = AgentConfigInstaller()
    private unowned let notifier: AgentNotifier

    private var watcher: DirectoryWatcher?
    private var checkTask: Task<Void, Never>?
    private var checkPending = false
    private var restores: [Date] = []
    /// Latched for the rest of the app's run once we give up, so the notice is
    /// posted once rather than on every further rewrite.
    private var stopped = false

    /// Change events arrive in bursts (temp file, rename, mode change); coalesce
    /// them so one save is one check.
    private static let debounce: Duration = .seconds(1)

    init(notifier: AgentNotifier) {
        self.notifier = notifier
    }

    func start() {
        guard watcher == nil else { return }
        // Resolved at start, not at init: the user can re-point the symlink.
        let watcher = DirectoryWatcher(path: installer.claudeSettingsWatchDirectory.path)
        self.watcher = watcher
        watcher.start { [weak self] _ in
            Task { @MainActor in self?.scheduleCheck() }
        }
    }

    func stop() {
        checkTask?.cancel()
        checkTask = nil
        checkPending = false
        watcher?.stop()
        watcher = nil
    }

    private func scheduleCheck() {
        guard !checkPending else { return }
        checkPending = true
        checkTask = Task { [weak self] in
            try? await Task.sleep(for: Self.debounce)
            guard let self, !Task.isCancelled else { return }
            self.checkPending = false
            self.check()
        }
    }

    private func check() {
        guard !stopped, !installer.claudeBridgeInstalled() else { return }
        let now = Date()
        switch HookRestorePolicy.decide(now: now, restores: restores) {
        case .holdOff:
            return
        case .stopAutoRestoring:
            stopped = true
            Log.agents.error("Claude hooks rewritten repeatedly; auto-restore paused")
            notifier.notice(
                title: "Claude hooks keep being rewritten",
                message: "Another tool keeps rewriting them — auto-restore paused."
            )
        case .restore:
            restores = HookRestorePolicy.record(now, in: restores)
            do {
                try installer.installClaudeHooks()
                Log.agents.notice("Claude hooks were modified by another tool; restored")
                notifier.notice(
                    title: "Claude hooks restored",
                    message: "Another tool modified them — Notch put them back."
                )
            } catch {
                Log.agents.error("Claude hook restore failed: \(String(describing: error))")
                notifier.notice(
                    title: "Claude hooks were modified",
                    message: "Another tool changed them and the reinstall failed."
                )
            }
        }
    }
}
