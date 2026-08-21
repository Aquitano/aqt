import AppKit

/// Executes intents produced by KeyRouter. Main actor only.
///
/// Switch semantics (BATTLEPLAN §1/§3.4): the letter's first match activates;
/// pressing again cycles through same-letter apps; when a cycle wraps back to
/// the app that was focused when the hold started, it hides instead (toggle).
@MainActor
final class AppSwitcher {
    private let registry: AppRegistry
    private let settings: SettingsStore

    /// The app the current rcmd hold started on, per letter — lets wrap-around
    /// hide the original target rather than re-focusing it.
    private var holdOrigin: [Character: String] = [:]

    init(registry: AppRegistry, settings: SettingsStore) {
        self.registry = registry
        self.settings = settings
    }

    func handle(_ intent: Intent) {
        switch intent {
        case .switchToLetter(let letter):
            switchTo(letter: letter)
        case .assignLetter:
            break // Phase 2: pin frontmost app + toast HUD.
        }
    }

    /// Called when rcmd is released so the next hold starts a fresh cycle.
    func endHold() {
        holdOrigin.removeAll()
    }

    private var assigner: LetterAssigner {
        LetterAssigner(
            customAssignments: Dictionary(
                uniqueKeysWithValues: settings.model.customAssignments.compactMap { key, value in
                    key.lowercased().first.map { ($0, value) }
                }
            )
        )
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
        let frontmostID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier

        if let index = matches.firstIndex(where: { $0.bundleID == frontmostID }) {
            if holdOrigin[letter] == nil { holdOrigin[letter] = frontmostID }
            let next = matches[(index + 1) % matches.count]
            if next.bundleID == frontmostID || next.bundleID == holdOrigin[letter] {
                // Wrapped back to where the hold began: hide instead of refocus.
                if settings.model.hideOnRepeat {
                    NSWorkspace.shared.frontmostApplication?.hide()
                }
            } else {
                activate(pairs: pairs, bundleID: next.bundleID)
            }
            return
        }

        if let first = matches.first {
            activate(pairs: pairs, bundleID: first.bundleID)
            return
        }

        guard settings.model.launchIfNotRunning else { return }
        launchInstalledApp(matching: letter)
    }

    private func activate(pairs: [(app: NSRunningApplication, candidate: AppCandidate)], bundleID: String) {
        guard let app = pairs.first(where: { $0.candidate.bundleID == bundleID })?.app else { return }
        app.activate()
    }

    /// No running app owns `letter` — find an installed one and launch it.
    private func launchInstalledApp(matching letter: Character) {
        registry.installedApps { installed in
            guard let match = installed.first(where: {
                LetterAssigner.dynamicLetter(for: $0.name) == letter
            }) else { return }
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: match.bundleID) else {
                return
            }
            NSWorkspace.shared.openApplication(at: url, configuration: .init())
        }
    }
}
