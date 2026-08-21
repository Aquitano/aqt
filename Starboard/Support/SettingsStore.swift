import Foundation
import Observation

/// Single source of truth for persisted preferences, UserDefaults-backed.
/// Every new preference goes in Model; never scatter raw defaults keys.
enum StagesTrigger: String, Codable {
    /// Tap Caps Lock to arm; the event is consumed so the lock never toggles.
    case capsLock
    /// Bare tap of Right Shift (press+release with no key in between).
    case rightShift
    case off
}

/// A saved workspace: apps plus the files/folders/URLs to open on restore.
struct Stage: Codable, Equatable, Identifiable {
    var id = UUID()
    var name: String
    /// Single lowercase letter that restores this Stage.
    var letter: String
    var apps: [StageApp]
}

struct StageApp: Codable, Equatable {
    var bundleID: String
    /// File paths or URLs opened when the Stage is restored.
    var openItems: [String] = []
}

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
        var stagesTrigger = StagesTrigger.capsLock
        var stages: [Stage] = []
        /// Bare 400 ms rcmd hold shows the letter→app hint grid.
        var showKeyHints = true
        /// Warp the pointer to the focused window's center after a switch.
        var mouseFollowsFocus = false

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
            stagesTrigger =
                (try? container.decodeIfPresent(StagesTrigger.self, forKey: .stagesTrigger))
                .flatMap { $0 } ?? .capsLock
            stages =
                (try? container.decodeIfPresent([Stage].self, forKey: .stages))
                .flatMap { $0 } ?? []
            showKeyHints =
                try container.decodeIfPresent(Bool.self, forKey: .showKeyHints) ?? true
            mouseFollowsFocus =
                try container.decodeIfPresent(Bool.self, forKey: .mouseFollowsFocus) ?? false
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

    // MARK: - Export / import

    func exportJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(model)
    }

    func importJSON(_ data: Data) throws {
        model = try JSONDecoder().decode(Model.self, from: data)
    }
}
