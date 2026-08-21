import Foundation
import Observation

/// Single source of truth for persisted preferences, UserDefaults-backed.
/// Every new preference goes in Model; never scatter raw defaults keys.
@Observable
final class SettingsStore {
    struct Model: Codable, Equatable {
        var hideOnRepeat = true
        var launchIfNotRunning = true
        var customAssignments: [String: String] = [:] // letter → bundleID
        // TODO(Phase 5/6): Spaces strategy choice, Stages trigger key, stages.
    }

    static let shared = SettingsStore()

    private static let key = "starboard.settings"

    private let defaults: UserDefaults

    var model: Model {
        didSet { persist() }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.key),
           let decoded = try? JSONDecoder().decode(Model.self, from: data) {
            model = decoded
        } else {
            model = Model()
        }
    }

    func assignment(for letter: Character) -> String? {
        model.customAssignments[letter.lowercased()]
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(model) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
