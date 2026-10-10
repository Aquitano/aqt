import AppKit
import StarboardCore
import SwiftUI

/// Runs the intents the event tap produces. Everything a Right Command hold
/// changes lives in `Hold`, created when the key goes down and dropped when
/// the hold ends, however it ends.
@MainActor
final class AppSwitcher {
    private struct Hold {
        var overlayTimer: Task<Void, Never>?
        /// Each letter's cycle order, fixed at its first Tab so recency
        /// changes mid-hold don't reshuffle it.
        var cycles: [Character: [String]] = [:]
        var front = Front.unknown
        /// Something came to the front, so the pointer may follow it.
        var movedFocus = false
    }

    /// What this hold last brought to the front. NSWorkspace learns of an
    /// activation only once the app confirms it, so a second press inside
    /// that gap would otherwise act on the app that was in front before.
    private enum Front {
        case unknown
        case app(String)
        case nothing
    }

    private let registry: AppRegistry
    private let config: ConfigStore
    private let windows: WindowService
    private let toast: ToastHUD
    private let stages: StagesController
    private let search = SearchModel()
    private lazy var panel = SearchPanelController(
        rootView: SearchOverlayContent(model: search) { [weak self] item in self?.choose(item) }
    )
    private var hold: Hold?
    private var resolution = Resolution()
    private var assigner = LetterAssigner()
    private var announcedUnresolved: [String] = []

    init(registry: AppRegistry, config: ConfigStore, windows: WindowService, toast: ToastHUD) {
        self.registry = registry
        self.config = config
        self.windows = windows
        self.toast = toast
        stages = StagesController(registry: registry, config: config, windows: windows, toast: toast)
    }

    func handle(_ intents: [Intent]) {
        intents.forEach(handle)
        syncPanel()
    }

    /// Turns the config's app names into bundle IDs. `announce` reports names
    /// that match no app, once per change and only after the installed apps
    /// are known.
    func refreshResolution(announce: Bool) {
        resolution = config.config.resolve(in: registry.records(naming: config.config.appNames))
        assigner = LetterAssigner(pins: resolution.pins)
        guard announce, registry.hasScannedInstalled, resolution.unresolved != announcedUnresolved else { return }
        announcedUnresolved = resolution.unresolved
        if let unknown = resolution.unresolved.first {
            toast.show(message: "No app named \"\(unknown)\" in the config")
        }
    }

    private func handle(_ intent: Intent) {
        switch intent {
        case .holdBegan:
            beginHold()
        case let .holdEnded(end):
            endHold(end)
        case let .switchToLetter(letter):
            switchTo(letter)
        case let .cycleLetter(letter):
            cycle(letter)
        case let .assignLetter(letter):
            pin(letter)
        case let .searchQuery(query):
            search.query = query
            if search.isShown || query.count > 1 {
                showResults()
            }
        case let .moveSelection(delta):
            if !search.isShown {
                showResults()
            }
            search.moveSelection(delta)
        case .cancelSearch:
            hold?.overlayTimer?.cancel()
            search.hide()
        case let .itemAction(action):
            perform(action)
        case let .jumpToSpace(number):
            SpaceSwitcher.jump(to: number)
        case let .adjacentSpace(direction):
            SpaceSwitcher.jumpAdjacent(direction)
        case .stagesArmed:
            toast.show(message: "Stages: a letter restores, = saves, - closes")
        case .stageBeginSave:
            Task { await stages.beginSave() }
        case let .stageRestore(letter):
            stages.restore(letter)
        case .stageClose:
            stages.closeActive()
        }
    }

    // MARK: - Hold

    private func beginHold() {
        hold?.overlayTimer?.cancel()
        refreshResolution(announce: false)
        registry.refreshInstalled()
        AppIcons.preload(registry.bundleIDs)
        let delay = config.config.overlayDelayMs
        hold = Hold(overlayTimer: Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            // A quick Right Command + letter never flashes the overlay; held
            // past the delay, it shows what the hold has typed so far. A
            // search already on screen keeps its selection.
            guard !Task.isCancelled, let self, !search.isShown else { return }
            showResults()
            syncPanel()
        })
    }

    private func endHold(_ end: HoldEnd) {
        if end == .commit, search.isShown, let item = search.selectedItem {
            open(item)
        }
        let movedFocus = hold?.movedFocus == true
        hold?.overlayTimer?.cancel()
        hold = nil
        search.hide()
        windows.endCycle()
        if end != .invalidated, movedFocus, config.config.mouseFollowsFocus {
            Task { [windows] in
                // Let the activation settle so the focused window is the new one.
                try? await Task.sleep(for: .milliseconds(150))
                if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
                    windows.warpPointer(toFocusedWindowOf: pid)
                }
            }
        }
    }

    // MARK: - Switching

    private func switchTo(_ letter: Character) {
        let matches = assigner.apps(for: letter, in: runningCandidates())
        if let front = frontBundleID, matches.contains(where: { $0.bundleID == front }) {
            repeatPress(on: front, letter: letter)
        } else if let first = matches.first {
            activate(first.bundleID)
        } else if config.config.launchIfNotRunning, let pinned = resolution.pins[letter] {
            launch(pinned)
        }
    }

    private func repeatPress(on bundleID: String, letter: Character) {
        switch config.config.repeatPress {
        case .cycleWindows:
            if let app = registry.runningApp(bundleID) {
                windows.stepWindows(of: app.processIdentifier)
                hold?.movedFocus = true
            }
        case .hide:
            registry.runningApp(bundleID)?.hide()
            hold?.front = .nothing
        case .cycleApps:
            cycle(letter)
        }
    }

    private func cycle(_ letter: Character) {
        let running = runningCandidates()
        if hold?.cycles[letter] == nil {
            hold?.cycles[letter] = assigner.apps(for: letter, in: running).map(\.bundleID)
        }
        let runningIDs = Set(running.map(\.bundleID))
        let order = (hold?.cycles[letter] ?? []).filter(runningIDs.contains)
        guard !order.isEmpty else { return }
        let index = frontBundleID.flatMap(order.firstIndex(of:)) ?? -1
        activate(order[(index + 1) % order.count])
    }

    private func pin(_ letter: Character) {
        guard let app = frontBundleID.flatMap(registry.runningApp) ?? NSWorkspace.shared.frontmostApplication,
              let bundleID = app.bundleIdentifier, let name = app.localizedName else { return }
        let reference = registry.reference(bundleID: bundleID, name: name)
        let pinned = config.update { config in
            config.pin(letter, to: reference, in: registry.records(naming: config.appNames))
        }
        if case let .failure(error) = pinned {
            toast.show(message: "Pin not saved: \(error.message)")
            return
        }
        toast.show(appName: name, letter: letter, icon: app.icon)
    }

    private var frontBundleID: String? {
        switch hold?.front ?? .unknown {
        case .unknown: NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        case let .app(bundleID): bundleID
        case .nothing: nil
        }
    }

    private func activate(_ bundleID: String) {
        guard let app = registry.runningApp(bundleID) else { return }
        app.activateReliably()
        hold?.front = .app(bundleID)
        hold?.movedFocus = true
    }

    private func launch(_ bundleID: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: .init())
        hold?.front = .app(bundleID)
        hold?.movedFocus = true
    }

    private func runningCandidates() -> [AppCandidate] {
        registry.candidates.filter { !resolution.excluded.contains($0.bundleID) }
    }

    // MARK: - Search

    /// An empty query lists the letter map with nothing selected; any other
    /// query ranks running and installed apps with the best match selected.
    private func showResults() {
        let running = runningCandidates()
        guard !search.query.isEmpty else {
            let rows = assigner.letterMap(running).map { letter, app in
                SearchModel.Item(
                    bundleID: app.bundleID,
                    title: app.name,
                    isRunning: true,
                    letter: letter,
                    matchedIndices: []
                )
            }
            search.show(rows, selecting: nil)
            return
        }

        let runningIDs = Set(running.map(\.bundleID))
        let candidates = running.enumerated().map { order, app in
            SearchCandidate(bundleID: app.bundleID, title: app.name, isRunning: true, order: order)
        } + registry.installed
            .filter { !runningIDs.contains($0.bundleID) && !resolution.excluded.contains($0.bundleID) }
            .map { SearchCandidate(bundleID: $0.bundleID, title: $0.name, isRunning: false, order: .max) }
        let runningLetters = assigner.letters(running)
        let pinnedLetters = Dictionary(assigner.pins.map { ($1, $0) }, uniquingKeysWith: min)
        let ranked = signposter.withIntervalSignpost("Search ranking") { Search.rank(search.query, in: candidates) }
        let rows = ranked.map { result in
            let bundleID = result.candidate.bundleID
            return SearchModel.Item(
                bundleID: bundleID,
                title: result.candidate.title,
                isRunning: result.candidate.isRunning,
                letter: result.candidate.isRunning ? runningLetters[bundleID] : pinnedLetters[bundleID],
                matchedIndices: result.matchedIndices
            )
        }
        search.show(rows, selecting: 0)
    }

    /// A click on a row.
    private func choose(_ item: SearchModel.Item) {
        open(item)
        search.hide()
        syncPanel()
    }

    private func open(_ item: SearchModel.Item) {
        if registry.runningApp(item.bundleID) != nil {
            activate(item.bundleID)
        } else {
            launch(item.bundleID)
        }
    }

    private func syncPanel() {
        if search.isShown {
            panel.present()
        } else {
            panel.hide()
        }
    }

    private func perform(_ action: SearchItemAction) {
        guard let item = search.selectedItem, let app = registry.runningApp(item.bundleID) else { return }
        switch action {
        case .close:
            windows.closeFrontWindow(of: app.processIdentifier)
        case .hide:
            app.hide()
        case .quit:
            app.terminate()
            search.removeApp(item.bundleID)
        }
    }
}
