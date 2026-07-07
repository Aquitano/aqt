import Foundation

/// One persistent scratch note backing the quick-note widget. Loads synchronously
/// at init (tiny file); saves are debounced per keystroke and written off-main.
@MainActor
final class NoteManager: ObservableObject {

    @Published var text: String {
        didSet { scheduleSave() }
    }

    private let persistence: Persistence
    private var saveTask: Task<Void, Never>?
    private let fileName = "quick-note.json"

    init(persistence: Persistence) {
        self.persistence = persistence
        self.text = persistence.load(String.self, from: fileName) ?? ""
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [persistence, text, fileName] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await Task.detached(priority: .utility) {
                persistence.save(text, to: fileName)
            }.value
        }
    }
}
