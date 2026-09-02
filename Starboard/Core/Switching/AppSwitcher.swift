import AppKit
import SwiftUI

/// Executes intents produced by KeyRouter. Main actor only.
///
/// Switch semantics (BATTLEPLAN §1/§3.4, mirroring rcmd): a letter press
/// focuses the letter's best match; pressing it when a matching app is already
/// frontmost steps through its windows MRU-first (or hides it / cycles
/// same-letter apps, per the repeat-press setting); Tab cycles same-letter
/// apps. Cycle order is snapshotted per hold — MRU re-sorting between presses
/// must not reshuffle a ring mid-cycle.
@MainActor
final class AppSwitcher {
    private let registry: AppRegistry
    private let settings: SettingsStore
    let searchModel: SearchModel
    let spaces: SpacesController
    let stages: StagesController

    /// Set when the Raycast extension runs Starboard: the hold overlay is
    /// mirrored into a Raycast list instead of the native panel.
    private let raycastSearch = HelperMode.current?.searchDeeplink.map(RaycastSearch.init)

    private lazy var searchPanel: SearchPanelController = {
        let hosting = NSHostingView(rootView: SearchOverlayContent(model: searchModel))
        // The controller owns the panel frame; auto-sizing would collapse the
        // HUD to its intrinsic size.
        hosting.sizingOptions = []
        return SearchPanelController(content: hosting)
    }()

    /// Per-letter cycle rings for the current rcmd hold, in the order they
    /// existed at the first Tab press. Cleared on release.
    private var holdCycles: [Character: [String]] = [:]

    /// Window ring for repeat presses on the frontmost app, snapshotted in
    /// MRU order at the first repeat press of the hold. Cleared on release,
    /// so a fresh press always lands on the app's last-focused window.
    private var holdWindowRing: (pid: pid_t, windows: [WindowInfo], index: Int)?

    /// Pending overlay countdown for the current rcmd hold, and whether it
    /// has fired. One timer governs the whole hold surface.
    private var holdTask: Task<Void, Never>?
    private var holdOverlayDue = false

    private var cachedAssigner: LetterAssigner?
    private var cachedPins: [String: String]?

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
            // Escape ends the hold's overlay for good — the pending timer
            // must not revive it while rcmd is still down.
            cancelHoldTimer()
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
        let pairs = runningPairs()
        guard let target = assigner.apps(for: letter, in: pairs.map(\.candidate)).first,
              let app = pairs.first(where: { $0.candidate.bundleID == target.bundleID })?.app else {
            return
        }
        WindowFocuser.cycleWindows(of: app)
    }

    private func syncSearchPanel() {
        guard searchModel.isVisible else {
            searchPanel.hide()
            raycastSearch?.dismiss()
            return
        }
        // A quick rcmd+letter switch shouldn't flash the overlay, so a
        // one-letter query waits for the hold timer, which then reveals the
        // panel with those results. Anything else — a longer query, the window
        // ring — is a deliberate search and shows at once.
        guard holdOverlayDue || searchModel.scope == .windows || searchModel.query.count > 1 else {
            return
        }
        // The ring stays native, and a hold that started native (typing into
        // the ring pivots to search) finishes native.
        if let raycastSearch, !searchModel.isRing, !searchPanel.shown {
            raycastSearch.present()
        } else {
            searchPanel.present()
        }
    }

    /// Raycast: Enter or click on a row. During a hold release still commits
    /// the helper's own selection; this is the mouse path and the
    /// opened-by-hand path.
    func focusSearchItem(id: String) -> Bool {
        let found = searchModel.focus(itemID: id)
        syncSearchPanel()
        return found
    }

    /// Raycast search opened by hand: the empty apps query shows the letter
    /// map, as the hold overlay does.
    func searchResults(query: String, scope: SearchModel.Scope) -> [SearchModel.Item] {
        if query.isEmpty, scope == .apps {
            return SearchModel.letterMap(candidates: runningPairs().map(\.candidate), assigner: assigner)
        }
        return searchModel.results(query: query, scope: scope)
    }

    /// Repeat press: step through the frontmost app's windows, second-most
    /// recent first (a plain switch already lands on the most recent).
    private func cycleFrontmostWindows() {
        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        let pid = app.processIdentifier
        if holdWindowRing?.pid != pid {
            // CGWindowList is front-to-back, which for a single app's windows
            // is exactly MRU order.
            let windows = WindowEnumerator.visibleWindows().filter { $0.pid == pid }
            holdWindowRing = (pid, windows, 0)
        }
        guard var ring = holdWindowRing, ring.windows.count > 1 else { return }
        ring.index = (ring.index + 1) % ring.windows.count
        holdWindowRing = ring
        WindowFocuser.focus(ring.windows[ring.index])
    }

    /// Called when rcmd is released so the next hold starts a fresh cycle.
    func endHold() {
        holdCycles.removeAll()
        holdWindowRing = nil
        cancelHoldTimer()
        // Releasing on the letter map (nothing selected) produces no intent of
        // its own, so the overlay is dismissed here.
        searchModel.cancel()
        syncSearchPanel()
        if settings.model.mouseFollowsFocus {
            MouseFollower.warpToFocusedWindow()
        }
    }

    // MARK: - Hold overlay

    /// rcmd pressed: a single 300 ms timer owns the overlay. Nothing is on
    /// screen before it fires, so a quick rcmd+letter switch never flashes the
    /// panel. When it fires it shows whatever the hold has produced so far —
    /// the one-letter query's results, or, if nothing was typed, the letter map.
    func holdBegan() {
        // The first Tab or backtick of the hold reads the window list on the
        // main thread; warm it now so that read is a cache hit.
        WindowEnumerator.prime()
        holdTask?.cancel()
        holdOverlayDue = false
        holdTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            self?.showHoldOverlay()
        }
    }

    private func showHoldOverlay() {
        holdOverlayDue = true
        if !searchModel.isVisible {
            searchModel.beginHold(candidates: runningPairs().map(\.candidate), assigner: assigner)
        }
        syncSearchPanel()
    }

    private func cancelHoldTimer() {
        holdTask?.cancel()
        holdTask = nil
        holdOverlayDue = false
    }

    /// Rebuilt only when the pins change — every intent asks for it, and
    /// folding the settings dictionary on each key press is pure overhead.
    private var assigner: LetterAssigner {
        let pins = settings.model.customAssignments
        if let cachedAssigner, cachedPins == pins { return cachedAssigner }
        let built = LetterAssigner(
            customAssignments: Dictionary(
                uniqueKeysWithValues: pins.compactMap { key, value in
                    key.lowercased().first.map { ($0, value) }
                }
            )
        )
        cachedPins = pins
        cachedAssigner = built
        return built
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
        let pairs = runningPairs()
        let matches = assigner.apps(for: letter, in: pairs.map(\.candidate))
        let frontmostID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier

        if let frontmostID, matches.contains(where: { $0.bundleID == frontmostID }) {
            switch settings.model.repeatPress {
            case .cycleWindows:
                cycleFrontmostWindows()
            case .hide:
                NSWorkspace.shared.frontmostApplication?.hide()
            case .cycleApps:
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
            return (app, AppCandidate(bundleID: bundleID, name: name, launchedAt: app.launchDate))
        }
    }

    private func activate(pairs: [(app: NSRunningApplication, candidate: AppCandidate)], bundleID: String) {
        guard let app = pairs.first(where: { $0.candidate.bundleID == bundleID })?.app else { return }
        app.activateReliably()
    }

    private func launch(bundleID: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            return
        }
        NSWorkspace.shared.openApplication(at: url, configuration: .init())
    }
}
