import Foundation

/// Everything Starboard can be told, read from a JSON file the user edits by
/// hand. Apps are named by app name ("Google Chrome") or bundle ID. Missing
/// keys take their defaults; unknown keys and wrong types are errors, so a
/// typo is reported instead of silently ignored.
public struct Config: Codable, Equatable, Sendable {
    /// Letter to app.
    public var assignments: [String: String] = [:]
    /// Apps that get no letter and never show in search.
    public var excluded: [String] = []
    public var repeatPress = RepeatPress.cycleWindows
    /// A letter whose pinned app is closed launches it.
    public var launchIfNotRunning = true
    public var overlayDelayMs = 300
    public var mouseFollowsFocus = false
    public var stagesLeader = StagesLeader.capsLock
    public var stages: [Stage] = []

    public init() {}

    enum CodingKeys: String, CodingKey, CaseIterable {
        case assignments, excluded, repeatPress, launchIfNotRunning, overlayDelayMs
        case mouseFollowsFocus, stagesLeader, stages
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = Config()
        assignments = try container.decodeIfPresent([String: String].self, forKey: .assignments) ?? defaults.assignments
        excluded = try container.decodeIfPresent([String].self, forKey: .excluded) ?? defaults.excluded
        repeatPress = try container.decodeIfPresent(RepeatPress.self, forKey: .repeatPress) ?? defaults.repeatPress
        launchIfNotRunning = try container.decodeIfPresent(Bool.self, forKey: .launchIfNotRunning) ?? defaults
            .launchIfNotRunning
        overlayDelayMs = try container.decodeIfPresent(Int.self, forKey: .overlayDelayMs) ?? defaults.overlayDelayMs
        mouseFollowsFocus = try container.decodeIfPresent(Bool.self, forKey: .mouseFollowsFocus) ?? defaults
            .mouseFollowsFocus
        stagesLeader = try container.decodeIfPresent(StagesLeader.self, forKey: .stagesLeader) ?? defaults.stagesLeader
        stages = try container.decodeIfPresent([Stage].self, forKey: .stages) ?? defaults.stages
    }

    public static func decode(_ data: Data) -> Result<Config, ConfigError> {
        let config: Config
        do {
            config = try JSONDecoder().decode(Config.self, from: data)
        } catch let error as DecodingError {
            return .failure(ConfigError(error))
        } catch {
            return .failure(ConfigError(message: error.localizedDescription))
        }
        return config.validated()
    }

    public func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        // Every field is a plain value type; encoding cannot fail.
        return (try? encoder.encode(self)) ?? Data()
    }

    /// Every app the config names.
    public var appNames: [String] {
        Array(assignments.values) + excluded + stages.flatMap { $0.apps.map(\.app) }
    }

    public func stage(_ letter: Character) -> Stage? {
        stages.first { Self.letter($0.letter) == letter }
    }

    public var stageLetters: Set<Character> {
        Set(stages.compactMap { Self.letter($0.letter) })
    }

    /// Pins `letter` to `app`. Whatever the letter named before, in either
    /// case, is dropped, and so is every other letter naming the same app,
    /// whether by name or by bundle ID.
    public mutating func pin(_ letter: Character, to app: String, in apps: [AppRecord]) {
        let target = Self.bundleID(for: app, in: apps)
        assignments = assignments.filter { key, value in
            guard Self.letter(key) != letter else { return false }
            guard let target else { return value.caseInsensitiveCompare(app) != .orderedSame }
            return Self.bundleID(for: value, in: apps) != target
        }
        assignments[String(letter)] = app
    }

    /// The single letter a-z that `text` names, case-insensitively.
    public static func letter(_ text: String) -> Character? {
        guard text.count == 1, let letter = text.lowercased().first,
              LetterAssigner.alphabet.contains(letter) else { return nil }
        return letter
    }

    /// The checks a decoded file must pass beyond its types.
    public func validated() -> Result<Config, ConfigError> {
        var pinned = Set<Character>()
        for key in assignments.keys.sorted() {
            guard let letter = Self.letter(key) else {
                return .failure(ConfigError(message: "assignments.\(key): keys must be single letters a-z"))
            }
            guard pinned.insert(letter).inserted else {
                return .failure(ConfigError(message: "assignments.\(key): \(letter) is assigned twice"))
            }
        }
        guard (50 ... 2000).contains(overlayDelayMs) else {
            return .failure(ConfigError(message: "overlayDelayMs: must be between 50 and 2000"))
        }
        var stageLetters = Set<Character>()
        for (index, stage) in stages.enumerated() {
            guard let letter = Self.letter(stage.letter) else {
                return .failure(ConfigError(message: "stages[\(index)].letter: must be a single letter a-z"))
            }
            guard stageLetters.insert(letter).inserted else {
                return .failure(ConfigError(message: "stages[\(index)].letter: \(letter) is used by another stage"))
            }
        }
        return .success(self)
    }
}

public enum RepeatPress: String, Codable, Sendable {
    /// Step through the app's windows, most recent first.
    case cycleWindows
    case hide
    /// The next app on the same letter.
    case cycleApps
}

public enum StagesLeader: String, Codable, Sendable {
    case capsLock
    /// A bare tap of Right Shift.
    case rightShift
    case off
}

/// A saved workspace: the apps to show, and the files or URLs to open when
/// restoring it has to launch one of them.
public struct Stage: Codable, Equatable, Sendable {
    public var letter: String
    public var name: String
    public var apps: [StageApp]

    public init(letter: String, name: String, apps: [StageApp]) {
        self.letter = letter
        self.name = name
        self.apps = apps
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case letter, name, apps
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        letter = try container.decode(String.self, forKey: .letter)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        apps = try container.decode([StageApp].self, forKey: .apps)
    }

    public var displayName: String {
        name.isEmpty ? "Stage \(letter.uppercased())" : name
    }
}

public struct StageApp: Codable, Equatable, Sendable {
    public var app: String
    public var open: [String]

    public init(app: String, open: [String] = []) {
        self.app = app
        self.open = open
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case app, open
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        app = try container.decode(String.self, forKey: .app)
        open = try container.decodeIfPresent([String].self, forKey: .open) ?? []
    }
}

public struct ConfigError: Error, Equatable, Sendable {
    public let message: String

    public init(message: String) {
        self.message = message
    }

    init(_ error: DecodingError) {
        switch error {
        case let .keyNotFound(key, context):
            message = "\(Self.path(context.codingPath + [key])): missing"
        case let .typeMismatch(_, context), let .valueNotFound(_, context), let .dataCorrupted(context):
            // Syntax errors carry their line and column in the underlying error.
            let underlying = (context.underlyingError as NSError?)?.userInfo[NSDebugDescriptionErrorKey] as? String
            let detail = underlying ?? context.debugDescription
            message = context.codingPath.isEmpty ? detail : "\(Self.path(context.codingPath)): \(detail)"
        @unknown default:
            message = error.localizedDescription
        }
    }

    private static func path(_ keys: [CodingKey]) -> String {
        keys.reduce("") { path, key in
            if let index = key.intValue {
                return "\(path)[\(index)]"
            }
            return path.isEmpty ? key.stringValue : "\(path).\(key.stringValue)"
        }
    }
}

// MARK: - Apps named in the config

/// An installed or running app and the names a config may call it by.
public struct AppRecord: Equatable, Sendable {
    public let bundleID: String
    public let names: [String]

    public init(bundleID: String, names: [String]) {
        self.bundleID = bundleID
        self.names = names
    }
}

/// The config's app names turned into bundle IDs.
public struct Resolution: Equatable, Sendable {
    public var pins: [Character: String] = [:]
    public var excluded: Set<String> = []
    /// Names that matched no app.
    public var unresolved: [String] = []

    public init() {}
}

public extension Config {
    func resolve(in apps: [AppRecord]) -> Resolution {
        var resolution = Resolution()
        for (key, name) in assignments.sorted(by: { $0.key < $1.key }) {
            guard let letter = Self.letter(key) else { continue }
            if let bundleID = Self.bundleID(for: name, in: apps) {
                resolution.pins[letter] = bundleID
            } else {
                resolution.unresolved.append(name)
            }
        }
        for name in excluded {
            if let bundleID = Self.bundleID(for: name, in: apps) {
                resolution.excluded.insert(bundleID)
            } else {
                resolution.unresolved.append(name)
            }
        }
        // Excluded wins: an app both pinned and excluded gets no letter.
        resolution.pins = resolution.pins.filter { !resolution.excluded.contains($0.value) }
        return resolution
    }

    /// A bundle ID matches first, then any of the app's names, ignoring case.
    static func bundleID(for name: String, in apps: [AppRecord]) -> String? {
        let name = name.trimmingCharacters(in: .whitespaces)
        if let match = apps.first(where: { $0.bundleID.caseInsensitiveCompare(name) == .orderedSame }) {
            return match.bundleID
        }
        return apps.first { app in
            app.names.contains { $0.caseInsensitiveCompare(name) == .orderedSame }
        }?.bundleID
    }
}

// MARK: - Decoding helpers

private struct AnyKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue _: Int) {
        nil
    }
}

extension Decoder {
    func rejectUnknownKeys<Key: CodingKey & CaseIterable>(_: Key.Type) throws {
        let known = Set(Key.allCases.map(\.stringValue))
        let container = try container(keyedBy: AnyKey.self)
        if let unknown = container.allKeys.first(where: { !known.contains($0.stringValue) }) {
            throw DecodingError.dataCorrupted(
                .init(codingPath: container.codingPath + [unknown], debugDescription: "unknown key")
            )
        }
    }
}
