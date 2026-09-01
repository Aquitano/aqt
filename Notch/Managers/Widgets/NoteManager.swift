import Foundation

/// One persistent scratch note backing the quick-note widget. Loads synchronously
/// at init (tiny file); saves are debounced per keystroke and written off-main.
@MainActor
@Observable
final class NoteManager {

    var text: String {
        didSet { scheduleSave() }
    }

    private let persistence: Persistence
    private var saveTask: Task<Void, Never>?
    private let fileName = "quick-note.json"

    init(persistence: Persistence, diagnostics: Diagnostics) {
        self.persistence = persistence
        do {
            self.text = try persistence.load(String.self, from: fileName) ?? ""
        } catch {
            diagnostics.report(source: "Quick note", error)
            self.text = ""
        }
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
