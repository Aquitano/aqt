import Foundation
import Observation

/// Single source of truth for persisted preferences, UserDefaults-backed.
/// Every new preference goes in Model; never scatter raw defaults keys.
enum SpacesStrategy: String, Codable {
    /// Post Mission Control shortcuts (ctrl+digit / ctrl+arrows). Animated,
    /// robust; ctrl+digit must be enabled in System Settings.
    case synthetic
    /// Private SkyLight APIs: instant, enables move-window and the menu bar
    /// Space number. Auto-falls back to synthetic when unavailable.
    case direct
}

@Observable
final class SettingsStore {
    struct Model: Codable, Equatable {
        var hideOnRepeat = true
        var launchIfNotRunning = true
        var customAssignments: [String: String] = [:] // letter → bundleID
        /// ralt+letter window jump. Off by default: right Option types special
        /// characters on many layouts, so consuming it must be a choice.
        var windowJumpEnabled = false
        var spacesStrategy = SpacesStrategy.synthetic
        /// ralt+digit moves the focused window to a Space (direct only).
        var spacesMoveWindowEnabled = false
        var showSpaceNumber = false

        // Every field decodes with decodeIfPresent + default so settings
        // persisted by older (or newer) versions never fail to load — a plain
        // synthesized decode would silently wipe them on any added field.
        init() {}

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            hideOnRepeat =
                try container.decodeIfPresent(Bool.self, forKey: .hideOnRepeat) ?? true
            launchIfNotRunning =
                try container.decodeIfPresent(Bool.self, forKey: .launchIfNotRunning) ?? true
            customAssignments =
                try container.decodeIfPresent([String: String].self, forKey: .customAssignments) ?? [:]
            windowJumpEnabled =
                try container.decodeIfPresent(Bool.self, forKey: .windowJumpEnabled) ?? false
            spacesStrategy =
                (try? container.decodeIfPresent(SpacesStrategy.self, forKey: .spacesStrategy))
                .flatMap { $0 } ?? .synthetic
            spacesMoveWindowEnabled =
                try container.decodeIfPresent(Bool.self, forKey: .spacesMoveWindowEnabled) ?? false
            showSpaceNumber =
                try container.decodeIfPresent(Bool.self, forKey: .showSpaceNumber) ?? false
        }
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
