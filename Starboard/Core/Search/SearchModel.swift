import AppKit
import Observation

/// Drives the fuzzy search overlay: holds the current results, selection, and
/// visibility; owns the overlay panel. Main actor.
@MainActor
@Observable
final class SearchModel {
    struct Item: Identifiable, Equatable {
        let bundleID: String
        let name: String
        let letter: Character?
        var id: String { bundleID }
    }

    private(set) var items: [Item] = []
    private(set) var selectedIndex = 0
    private(set) var isVisible = false

    private let registry: AppRegistry

    init(registry: AppRegistry) {
        self.registry = registry
    }

    var selectedItem: Item? {
        items.indices.contains(selectedIndex) ? items[selectedIndex] : nil
    }

    func setQuery(_ query: String) {
        guard query.count >= 2 else {
            hide()
            return
        }

        let candidates: [(Item, String)] = registry.runningApps.compactMap { app in
            guard let id = app.bundleIdentifier, let name = app.localizedName else { return nil }
            return (Item(bundleID: id, name: name, letter: LetterAssigner.dynamicLetter(for: name)), name)
        }

        items = candidates.compactMap { item, name in
            FuzzyMatcher.score(query: query, target: name).map { (item, $0) }
        }
        .sorted { $0.1 > $1.1 }
        .map(\.0)

        selectedIndex = 0
        isVisible = true
    }

    func moveSelection(_ delta: Int) {
        guard !items.isEmpty else { return }
        selectedIndex = (selectedIndex + delta + items.count) % items.count
    }

    func cancel() {
        hide()
    }

    /// Focus the selected app and dismiss.
    func commit() {
        if let selected = selectedItem,
           let app = registry.runningApps.first(where: { $0.bundleIdentifier == selected.bundleID }) {
            app.activate()
        }
        hide()
    }

    /// Acts on the selection but keeps the overlay open — the user is still
    /// mid-hold and may act on further results or commit a different one.
    func perform(_ action: SearchItemAction) {
        guard let selected = selectedItem,
              let app = registry.runningApps.first(where: { $0.bundleIdentifier == selected.bundleID }) else {
            return
        }
        switch action {
        case .hide:
            app.hide()
        case .quit:
            app.terminate()
            items.removeAll { $0.id == selected.id }
            if selectedIndex >= items.count { selectedIndex = max(0, items.count - 1) }
        case .close:
            AXWindowActions.closeFrontmostWindow(of: app)
        }
    }

    private func hide() {
        isVisible = false
        items = []
        selectedIndex = 0
    }
}
