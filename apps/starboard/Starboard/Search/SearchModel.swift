import Observation

/// What the search overlay shows: the query, the rows and the selection.
@MainActor
@Observable
final class SearchModel {
    struct Item: Identifiable, Equatable {
        let bundleID: String
        let title: String
        let isRunning: Bool
        /// The letter that opens this app, if one does.
        let letter: Character?
        /// Character offsets into `title` that the query matched.
        let matchedIndices: [Int]

        var id: String {
            bundleID
        }
    }

    var query = ""
    private(set) var items: [Item] = []
    /// nil on the letter map: releasing there opens nothing.
    private(set) var selectedIndex: Int?
    private(set) var isShown = false

    var selectedItem: Item? {
        selectedIndex.flatMap { items.indices.contains($0) ? items[$0] : nil }
    }

    func show(_ items: [Item], selecting index: Int?) {
        self.items = items
        selectedIndex = index.flatMap { items.indices.contains($0) ? $0 : nil }
        isShown = true
    }

    func moveSelection(_ delta: Int) {
        guard !items.isEmpty else { return }
        // From no selection, down lands on the first row and up on the last.
        let current = selectedIndex ?? (delta > 0 ? -1 : 0)
        selectedIndex = (current + delta + items.count) % items.count
    }

    func remove(_ item: Item) {
        items.removeAll { $0.id == item.id }
        if let index = selectedIndex, index >= items.count {
            selectedIndex = items.isEmpty ? nil : items.count - 1
        }
    }

    func hide() {
        isShown = false
        items = []
        selectedIndex = nil
        query = ""
    }
}
