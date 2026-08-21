import AppKit
import SwiftUI

/// Executes intents produced by KeyRouter. Main actor only.
///
/// Switch semantics (BATTLEPLAN §1/§3.4, mirroring rcmd): a letter press
/// focuses the letter's best match; pressing it when a matching app is already
/// frontmost hides it (or cycles when hide-on-repeat is off); Tab cycles
/// same-letter apps. Cycle order is snapshotted per hold — MRU re-sorting
/// between presses must not reshuffle the ring mid-cycle.
@MainActor
final class AppSwitcher {
    private let registry: AppRegistry
    private let settings: SettingsStore
    let searchModel: SearchModel
    let spaces: SpacesController
    let stages: StagesController

    private lazy var searchPanel = SearchPanelController(
        content: NSHostingView(rootView: SearchOverlayContent(model: searchModel))
    )
    private var searchPanelShown = false

    /// Per-letter cycle rings for the current rcmd hold, in the order they
    /// existed at the first Tab press. Cleared on release.
    private var holdCycles: [Character: [String]] = [:]

    init(registry: AppRegistry, settings: SettingsStore) {
        self.registry = registry
        self.settings = settings
        self.searchModel = SearchModel(registry: registry)
        self.spaces = SpacesController(settings: settings)
        self.stages = StagesController(settings: settings)
    }

    func handle(_ intent: Intent) {
        switch intent {
        case .switchToLetter(let letter):
            switchTo(letter: letter)
        case .cycleLetter(let letter):
            cycle(letter: letter)
        case .assignLetter(let letter):
            assign(letter: letter)
        case .searchQuery(let query):
            searchModel.setQuery(query)
        case .moveSelection(let delta):
            searchModel.moveSelection(delta)
        case .commitSearch:
            searchModel.commit()
        case .cancelSearch:
            searchModel.cancel()
        case .itemAction(let action):
            searchModel.perform(action)
        case .beginWindowCycle:
            searchModel.beginWindowCycle()
        case .beginWindowSearch:
            searchModel.beginWindowSearch()
        case .cycleAppWindows:
            WindowFocuser.cycleFrontmostAppWindows()
        case .jumpAppWindows(let letter):
            jumpWindows(letter: letter)
        case .jumpToSpace(let index):
            spaces.jump(to: index)
        case .adjacentSpace(let direction):
            spaces.jumpAdjacent(direction)
        case .moveWindowToSpace(let index):
            spaces.moveFocusedWindow(to: index)
        case .stagesArmed:
            ToastHUD.shared.show(message: "Stages — letter: restore · =: save · –: close")
        case .stageBeginSave:
            stages.beginSave()
        case .stageRestore(let letter):
            stages.restore(letter: letter)
        case .stageClose:
            stages.closeActive()
        }
        syncSearchPanel()
    }

    /// ralt+letter: step through the windows of the letter's app.
    private func jumpWindows(letter: Character) {
        registry.refresh()
        let pairs = runningPairs()
        guard let target = assigner.apps(for: letter, in: pairs.map(\.candidate)).first,
              let app = pairs.first(where: { $0.candidate.bundleID == target.bundleID })?.app else {
            return
        }
        WindowFocuser.cycleWindows(of: app)
    }

    private func syncSearchPanel() {
        if searchModel.isVisible && !searchPanelShown {
            searchPanel.show()
        } else if !searchModel.isVisible && searchPanelShown {
            searchPanel.hide()
        }
        searchPanelShown = searchModel.isVisible
    }

    /// Called when rcmd is released so the next hold starts a fresh cycle.
    func endHold() {
        holdCycles.removeAll()
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

    /// rcmd+ralt+letter: pin the frontmost app to `letter`, persisted by bundle
    /// ID so it stays assigned (and launchable) across relaunches.
    private func assign(letter: Character) {
        guard let frontmost = NSWorkspace.shared.frontmostApplication,
              let bundleID = frontmost.bundleIdentifier else { return }
        settings.model.customAssignments["\(letter)"] = bundleID
        ToastHUD.shared.show(
            appName: frontmost.localizedName ?? "app",
            letter: letter,
            icon: frontmost.icon
        )
    }

    private func switchTo(letter: Character) {
        registry.refresh()
        let pairs = runningPairs()
        let matches = assigner.apps(for: letter, in: pairs.map(\.candidate))
        let frontmostID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier

        if let frontmostID, matches.contains(where: { $0.bundleID == frontmostID }) {
            if settings.model.hideOnRepeat {
                NSWorkspace.shared.frontmostApplication?.hide()
            } else {
                cycle(letter: letter)
            }
            return
        }

        if let first = matches.first {
            activate(pairs: pairs, bundleID: first.bundleID)
            return
        }

        guard settings.model.launchIfNotRunning else { return }
        if let pinnedID = assigner.customAssignments[letter] {
            launch(bundleID: pinnedID)
        } else {
            registry.installedApps { installed in
                guard let match = installed.first(where: {
                    LetterAssigner.dynamicLetter(for: $0.name) == letter
                }) else { return }
                self.launch(bundleID: match.bundleID)
            }
        }
    }

    /// Tab (or repeat press with hide-on-repeat off): advance the letter's ring.
    private func cycle(letter: Character) {
        registry.refresh()
        let pairs = runningPairs()
        if holdCycles[letter] == nil {
            holdCycles[letter] = assigner.apps(for: letter, in: pairs.map(\.candidate)).map(\.bundleID)
        }
        // Keep the snapshot's order; drop apps that quit mid-hold.
        let order = (holdCycles[letter] ?? []).filter { id in
            pairs.contains { $0.candidate.bundleID == id }
        }
        guard !order.isEmpty else { return }

        let frontmostID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let index = frontmostID.flatMap { order.firstIndex(of: $0) }
        let next = order[((index ?? -1) + 1) % order.count]
        activate(pairs: pairs, bundleID: next)
    }

    private func runningPairs() -> [(app: NSRunningApplication, candidate: AppCandidate)] {
        registry.runningApps.compactMap { app in
            guard let bundleID = app.bundleIdentifier, let name = app.localizedName else {
                return nil
            }
            return (app, AppCandidate(bundleID: bundleID, name: name))
        }
    }

    private func activate(pairs: [(app: NSRunningApplication, candidate: AppCandidate)], bundleID: String) {
        guard let app = pairs.first(where: { $0.candidate.bundleID == bundleID })?.app else { return }
        app.activate()
    }

    private func launch(bundleID: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            return
        }
        NSWorkspace.shared.openApplication(at: url, configuration: .init())
    }
}
