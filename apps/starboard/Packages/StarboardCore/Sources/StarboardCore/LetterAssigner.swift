import Foundation

/// A running app as the letter rules see it.
public struct AppCandidate: Equatable, Sendable {
    public let bundleID: String
    public let name: String
    public let launchedAt: Date?
    public let letter: Character?

    public init(bundleID: String, name: String, launchedAt: Date? = nil) {
        self.bundleID = bundleID
        self.name = name
        self.launchedAt = launchedAt
        letter = LetterAssigner.dynamicLetter(for: name)
    }
}

/// Maps letters to apps. A pinned app owns its letter; every other app is
/// reached by the first letter of its name.
public struct LetterAssigner: Equatable, Sendable {
    public static let alphabet = Array("abcdefghijklmnopqrstuvwxyz")

    /// Letter to bundle ID.
    public var pins: [Character: String]

    public init(pins: [Character: String] = [:]) {
        self.pins = pins
    }

    /// The apps a letter reaches, in cycle order: the pinned app, then
    /// name matches by launch time. Launch time keeps a letter on the same
    /// app for as long as it runs, however recently the others were used. An
    /// app pinned to another letter never matches by name.
    public func apps(for letter: Character, in candidates: [AppCandidate]) -> [AppCandidate] {
        let pinnedID = pins[letter]
        let pinned = candidates.filter { $0.bundleID == pinnedID }
        let pinnedIDs = Set(pins.values)
        let byName = candidates
            .filter { $0.letter == letter && !pinnedIDs.contains($0.bundleID) }
            .sorted { ($0.launchedAt ?? .distantFuture) < ($1.launchedAt ?? .distantFuture) }
        return pinned + byName
    }

    /// The app each letter opens first, alphabetically.
    public func letterMap(_ candidates: [AppCandidate]) -> [(letter: Character, app: AppCandidate)] {
        Self.alphabet.compactMap { letter in
            apps(for: letter, in: candidates).first.map { (letter, $0) }
        }
    }

    /// The letter that opens each app first, keyed by bundle ID. Apps that
    /// are only reached by cycling have none.
    public func letters(_ candidates: [AppCandidate]) -> [String: Character] {
        Dictionary(letterMap(candidates).map { ($0.app.bundleID, $0.letter) }) { first, _ in first }
    }

    /// First letter or digit of the name, lowercased, diacritics folded:
    /// "Übersicht" is "u", "1Password" is "1".
    public static func dynamicLetter(for name: String) -> Character? {
        name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            .first { $0.isLetter || $0.isNumber }
    }
}
