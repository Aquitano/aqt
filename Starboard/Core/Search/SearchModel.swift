import AppKit
import Observation

/// Drives the fuzzy search overlay and the rcmd+Tab window ring: holds the
/// current results, selection, scope, and visibility. Main actor.
@MainActor
@Observable
final class SearchModel {
    enum Scope: Equatable { case apps, windows }

    struct Item: Identifiable, Equatable {
        enum Kind: Equatable {
            case runningApp(bundleID: String)
            case installedApp(bundleID: String)
            case window(WindowInfo)
        }

        let kind: Kind
        let title: String
        /// Secondary label: "Launch" for installed apps, app name for windows.
        let subtitle: String?
        let letter: Character?

        var id: String {
            switch kind {
            case .runningApp(let bundleID): return "app.\(bundleID)"
            case .installedApp(let bundleID): return "installed.\(bundleID)"
            case .window(let window): return "window.\(window.id)"
            }
        }

        var iconBundleID: String? {
            switch kind {
            case .runningApp(let bundleID), .installedApp(let bundleID): return bundleID
            case .window(let window): return window.bundleID
            }
        }
    }

    private(set) var items: [Item] = []
    /// nil while the overlay shows the letter map: no row is highlighted until
    /// the user types or arrows into one, so releasing then commits nothing.
    private(set) var selectedIndex: Int?
    private(set) var isVisible = false
    private(set) var scope: Scope = .apps
    /// The typed query, displayed in the overlay's search field.
    private(set) var query = ""

    private let registry: AppRegistry
    private let windowProvider: () -> [WindowInfo]
    /// The current hold's letter map, restored when the query is emptied.
    private var letterItems: [Item] = []

    init(
        registry: AppRegistry,
        windowProvider: @escaping () -> [WindowInfo] = WindowEnumerator.visibleWindows
    ) {
        self.registry = registry
        self.windowProvider = windowProvider
    }

    var selectedItem: Item? {
        selectedIndex.flatMap { items.indices.contains($0) ? items[$0] : nil }
    }

    // MARK: - Entry points

    /// Results appear from the very first character — the user must see what
    /// their input resolves to immediately, not two keys later.
    func setQuery(_ query: String) {
        self.query = query
        guard !query.isEmpty else {
            // Backspacing to empty returns to the hold's letter map; outside a
            // hold there is nothing left to show.
            guard !letterItems.isEmpty else {
                hide()
                return
            }
            items = letterItems
            selectedIndex = nil
            return
        }
        items = scope == .windows ? windowMatches(query) : appMatches(query)
        selectedIndex = 0
        isVisible = true
    }

    /// rcmd held with nothing typed: the empty-query state lists the letter
    /// map — the app each a-z letter focuses — with no selection.
    func beginHold(candidates: [AppCandidate], assigner: LetterAssigner) {
        scope = .apps
        query = ""
        letterItems = Self.letterMap(candidates: candidates, assigner: assigner)
        items = letterItems
        selectedIndex = nil
        isVisible = !items.isEmpty
    }

    private static func letterMap(
        candidates: [AppCandidate],
        assigner: LetterAssigner
    ) -> [Item] {
        "abcdefghijklmnopqrstuvwxyz".compactMap { letter in
            assigner.apps(for: letter, in: candidates).first.map { app in
                Item(
                    kind: .runningApp(bundleID: app.bundleID),
                    title: app.name,
                    subtitle: nil,
                    letter: letter
                )
            }
        }
    }

    /// rcmd+Tab: show every visible window, selection starting on the second
    /// (the "next" window, Cmd-Tab style).
    func beginWindowCycle() {
        scope = .windows
        query = ""
        items = windowProvider().map(windowItem)
        selectedIndex = items.count > 1 ? 1 : 0
        isVisible = !items.isEmpty
    }

    /// Double-tap rcmd: windows-only search, empty query lists everything.
    func beginWindowSearch() {
        scope = .windows
        query = ""
        items = windowProvider().map(windowItem)
        selectedIndex = 0
        isVisible = true
    }

    func moveSelection(_ delta: Int) {
        guard !items.isEmpty else { return }
        // From no selection the first move lands where the user is heading:
        // down on the first row, up on the last.
        let current = selectedIndex ?? (delta > 0 ? -1 : 0)
        selectedIndex = (current + delta + items.count) % items.count
    }

    func cancel() {
        hide()
    }

    /// Focus (or launch) the selection and dismiss.
    func commit() {
        switch selectedItem?.kind {
        case .runningApp(let bundleID):
            runningApp(bundleID)?.activateReliably()
        case .installedApp(let bundleID):
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
                NSWorkspace.shared.openApplication(at: url, configuration: .init())
            }
        case .window(let window):
            WindowFocuser.focus(window)
        case nil:
            break
        }
        hide()
    }

    /// Mouse click on a row: make it the selection, then commit it.
    func commit(_ item: Item) {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        selectedIndex = index
        commit()
    }

    /// Acts on the selection but keeps the overlay open — the user is still
    /// mid-hold and may act on further results or commit a different one.
    func perform(_ action: SearchItemAction) {
        guard let selected = selectedItem else { return }

        switch (action, selected.kind) {
        case (.close, .window(let window)):
            AXWindowActions.close(window)
            removeSelected()
        case (.close, _):
            appForSelection().map(AXWindowActions.closeFrontmostWindow)
        case (.hide, _):
            appForSelection()?.hide()
        case (.quit, _):
            appForSelection()?.terminate()
            removeSelected()
        }
    }

    // MARK: - Matching

    private func appMatches(_ query: String) -> [Item] {
        registry.ensureInstalledScan()

        let running: [(Item, String)] = registry.runningApps.compactMap { app in
            guard let id = app.bundleIdentifier, let name = app.localizedName else { return nil }
            return (
                Item(
                    kind: .runningApp(bundleID: id),
                    title: name,
                    subtitle: nil,
                    letter: LetterAssigner.dynamicLetter(for: name)
                ),
                name
            )
        }
        let runningIDs = Set(registry.runningApps.compactMap(\.bundleIdentifier))
        let installed: [(Item, String)] = registry.cachedInstalledApps
            .filter { !runningIDs.contains($0.bundleID) }
            .map { candidate in
                (
                    Item(
                        kind: .installedApp(bundleID: candidate.bundleID),
                        title: candidate.name,
                        subtitle: "Launch",
                        letter: nil
                    ),
                    candidate.name
                )
            }

        return rank(query, candidates: running + installed)
    }

    private func windowMatches(_ query: String) -> [Item] {
        let candidates = windowProvider().map { window in
            (windowItem(window), "\(window.displayTitle) \(window.appName)")
        }
        return rank(query, candidates: candidates)
    }

    private func rank(_ query: String, candidates: [(Item, String)]) -> [Item] {
        let interval = Perf.beginSearchRanking()
        defer { Perf.endSearchRanking(interval) }
        return candidates.compactMap { item, target in
            FuzzyMatcher.score(query: query, target: target).map { (item, $0) }
        }
        .sorted { $0.1 > $1.1 }
        .map(\.0)
    }

    private func windowItem(_ window: WindowInfo) -> Item {
        Item(
            kind: .window(window),
            title: window.displayTitle,
            subtitle: window.appName,
            letter: nil
        )
    }

    // MARK: - Helpers

    private func appForSelection() -> NSRunningApplication? {
        switch selectedItem?.kind {
        case .runningApp(let bundleID):
            return runningApp(bundleID)
        case .window(let window):
            return NSRunningApplication(processIdentifier: window.pid)
        default:
            return nil
        }
    }

    private func runningApp(_ bundleID: String) -> NSRunningApplication? {
        registry.runningApps.first { $0.bundleIdentifier == bundleID }
    }

    private func removeSelected() {
        guard let selected = selectedItem else { return }
        items.removeAll { $0.id == selected.id }
        if let index = selectedIndex, index >= items.count {
            selectedIndex = items.isEmpty ? nil : items.count - 1
        }
    }

    private func hide() {
        isVisible = false
        items = []
        letterItems = []
        selectedIndex = nil
        scope = .apps
        query = ""
    }
}
