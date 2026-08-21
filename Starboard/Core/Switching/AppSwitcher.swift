import AppKit

/// Executes intents produced by KeyRouter. Must be called on the main thread.
final class AppSwitcher {
    private let registry: AppRegistry
    private var assigner = LetterAssigner()

    init(registry: AppRegistry) {
        self.registry = registry
    }

    func handle(_ intent: Intent) {
        switch intent {
        case .switchToLetter(let letter):
            switchTo(letter: letter)
        case .assignLetter:
            // TODO(Phase 2): pin the frontmost app to the letter, persist via
            // SettingsStore, show a confirmation toast HUD.
            break
        }
    }

    private func switchTo(letter: Character) {
        registry.refresh()
        let pairs: [(app: NSRunningApplication, candidate: AppCandidate)] =
            registry.runningApps.compactMap { app in
                guard let bundleID = app.bundleIdentifier, let name = app.localizedName else {
                    return nil
                }
                return (app, AppCandidate(bundleID: bundleID, name: name))
            }

        let matches = assigner.apps(for: letter, in: pairs.map(\.candidate))
        guard let target = matches.first,
              let app = pairs.first(where: { $0.candidate == target })?.app else {
            // TODO(Phase 1): launch installed-but-not-running apps
            // (BATTLEPLAN §3.4, launch-if-closed setting).
            return
        }

        if app.isActive {
            // TODO(Phase 1): cycle to the next same-letter app before falling
            // back to hide; respect the hide-on-repeat setting.
            app.hide()
        } else {
            app.activate()
        }
    }
}
