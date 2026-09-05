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

/// What pressing an already-focused app's letter does.
enum RepeatPressAction: String, Codable {
    /// Step through the app's windows, most recently used first.
    case cycleWindows
    /// Hide the app.
    case hide
    /// Cycle other apps assigned to the same letter.
    case cycleApps
}

enum SpacesStrategy: String, Codable {
    /// Post Mission Control shortcuts (ctrl+digit / ctrl+arrows). Animated,
    /// robust; ctrl+digit must be enabled in System Settings.
    case synthetic
    /// Private SkyLight APIs: instant, enables move-window and the menu bar
    /// Space number. Auto-falls back to synthetic when unavailable.
    case direct
}

/// The modifier key held down to trigger Starboard switching.
enum PrimaryModifier: String, Codable, CaseIterable, Identifiable {
    case rightCommand
    case rightOption
    case rightControl
    case leftOption
    case fn

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .rightCommand: return "Right ⌘ (Command)"
        case .rightOption: return "Right ⌥ (Option)"
        case .rightControl: return "Right ⌃ (Control)"
        case .leftOption: return "Left ⌥ (Option)"
        case .fn: return "fn / Globe"
        }
    }

    var shortName: String {
        switch self {
        case .rightCommand: return "Right ⌘"
        case .rightOption: return "Right ⌥"
        case .rightControl: return "Right ⌃"
        case .leftOption: return "Left ⌥"
        case .fn: return "fn"
        }
    }

    var secondaryShortName: String {
        switch self {
        case .rightCommand, .rightControl, .fn:
            return "Right ⌥"
        case .rightOption:
            return "Right ⌘"
        case .leftOption:
            return "Right ⌥"
        }
    }

    func secondaryIsHeld(in state: ModifierState) -> Bool {
        switch self {
        case .rightCommand, .rightControl, .fn:
            return state.rightOptionHeld
        case .rightOption:
            return state.rightCommandHeld
        case .leftOption:
            return state.rightOptionHeld || state.rightCommandHeld
        }
    }
}

@Observable
@MainActor
final class SettingsStore {
    struct Model: Codable, Equatable {
        var primaryModifier = PrimaryModifier.rightCommand
        var holdOverlayDelayMs = 300 {
            didSet {
                let clamped = min(max(50, holdOverlayDelayMs), 2000)
                if holdOverlayDelayMs != clamped {
                    holdOverlayDelayMs = clamped
                }
            }
        }
        var repeatPress = RepeatPressAction.cycleWindows
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
        /// Warp the pointer to the focused window's center after a switch.
        var mouseFollowsFocus = false
        /// Bundle IDs of apps excluded from dynamic assignments and search.
        var excludedBundleIDs: [String] = []

        /// Set of excluded bundle IDs for O(1) membership checks.
        var excludedBundleIDSet: Set<String> {
            Set(excludedBundleIDs)
        }

        // Every field decodes with decodeIfPresent + default so settings
        // persisted by older (or newer) versions never fail to load — a plain
        // synthesized decode would silently wipe them on any added field.
        init() {}

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            primaryModifier =
                (try? container.decodeIfPresent(PrimaryModifier.self, forKey: .primaryModifier))
                .flatMap { $0 } ?? .rightCommand
            let decodedDelay =
                (try? container.decodeIfPresent(Int.self, forKey: .holdOverlayDelayMs))
                .flatMap { $0 } ?? 300
            holdOverlayDelayMs = min(max(50, decodedDelay), 2000)
            repeatPress =
                (try? container.decodeIfPresent(RepeatPressAction.self, forKey: .repeatPress))
                .flatMap { $0 } ?? .cycleWindows
            launchIfNotRunning =
                (try? container.decodeIfPresent(Bool.self, forKey: .launchIfNotRunning))
                .flatMap { $0 } ?? true
            customAssignments =
                (try? container.decodeIfPresent([String: String].self, forKey: .customAssignments))
                .flatMap { $0 } ?? [:]
            windowJumpEnabled =
                (try? container.decodeIfPresent(Bool.self, forKey: .windowJumpEnabled))
                .flatMap { $0 } ?? false
            spacesStrategy =
                (try? container.decodeIfPresent(SpacesStrategy.self, forKey: .spacesStrategy))
                .flatMap { $0 } ?? .synthetic
            spacesMoveWindowEnabled =
                (try? container.decodeIfPresent(Bool.self, forKey: .spacesMoveWindowEnabled))
                .flatMap { $0 } ?? false
            showSpaceNumber =
                (try? container.decodeIfPresent(Bool.self, forKey: .showSpaceNumber))
                .flatMap { $0 } ?? false
            stagesTrigger =
                (try? container.decodeIfPresent(StagesTrigger.self, forKey: .stagesTrigger))
                .flatMap { $0 } ?? .capsLock
            stages =
                (try? container.decodeIfPresent([Stage].self, forKey: .stages))
                .flatMap { $0 } ?? []
            mouseFollowsFocus =
                (try? container.decodeIfPresent(Bool.self, forKey: .mouseFollowsFocus))
                .flatMap { $0 } ?? false
            excludedBundleIDs =
                (try? container.decodeIfPresent([String].self, forKey: .excludedBundleIDs))
                .flatMap { $0 } ?? []
        }
    }

    /// Where the model lives. The standalone app keeps UserDefaults; the
    /// Raycast helper is pointed at a JSON file the extension also edits, so
    /// that backend watches for external writes and reloads (HelperMode).
    enum Storage {
        case defaults(UserDefaults)
        case file(URL)
    }

    static let shared = SettingsStore(
        storage: HelperMode.current.map { .file($0.configURL) } ?? .defaults(.standard)
    )

    private static let key = "starboard.settings"

    private let storage: Storage
    @ObservationIgnored private var fileWatcher: FileWatcher?

    var model: Model {
        didSet { schedulePersist() }
    }

    /// Persisting encodes the whole model, so bursts of mutations (pinning
    /// mid-hold, typing in the Stage items editor) coalesce into one write.
    @ObservationIgnored private var persistPending = false
    @ObservationIgnored private var reloadAttempts = 0

    convenience init(defaults: UserDefaults = .standard) {
        self.init(storage: .defaults(defaults))
    }

    init(storage: Storage) {
        self.storage = storage
        model = Self.load(from: storage) ?? Model()
        if case .file(let url) = storage {
            if !FileManager.default.fileExists(atPath: url.path) {
                persistPending = true
                flush()
            }
            fileWatcher = FileWatcher(url: url) { [weak self] in self?.reloadFromFile() }
        }
    }

    /// Writes a coalesced change immediately. Call before reading the defaults
    /// back; the app itself never has to.
    func flush() {
        guard persistPending else { return }
        persistPending = false
        guard let data = try? exportJSON() else { return }
        switch storage {
        case .defaults(let defaults):
            defaults.set(data, forKey: Self.key)
        case .file(let url):
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            // In place, not atomic: an atomic write replaces the inode the
            // watcher holds and the extension's own watcher would see a delete.
            try? data.write(to: url)
        }
    }

    private func schedulePersist() {
        guard !persistPending else { return }
        persistPending = true
        DispatchQueue.main.async { [weak self] in self?.flush() }
    }

    private static func load(from storage: Storage) -> Model? {
        let data: Data?
        switch storage {
        case .defaults(let defaults): data = defaults.data(forKey: key)
        case .file(let url): data = try? Data(contentsOf: url)
        }
        return data.flatMap { try? JSONDecoder().decode(Model.self, from: $0) }
    }

    /// An external edit (the Raycast extension) replaces the model without
    /// echoing a write back; the file already holds what was just read.
    ///
    /// Writes are in place, so an event can land on a half-written file. That
    /// decodes to nil and is a torn read, not a bad file — reading again once
    /// the write settles is what keeps the edit from being dropped for good.
    private func reloadFromFile() {
        guard let loaded = Self.load(from: storage) else {
            guard reloadAttempts < 3 else { return }
            reloadAttempts += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.reloadFromFile()
            }
            return
        }
        reloadAttempts = 0
        guard loaded != model else { return }
        model = loaded
        persistPending = false
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
