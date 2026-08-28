import Foundation

/// An app as the assignment engine sees it — a value type so the engine stays
/// pure and unit-testable without AppKit.
struct AppCandidate: Equatable {
    let bundleID: String
    let name: String
    var launchedAt: Date?
    /// The name's dynamic letter, folded once here: building the letter map
    /// asks every candidate 26 times.
    let letter: Character?

    init(bundleID: String, name: String, launchedAt: Date? = nil) {
        self.bundleID = bundleID
        self.name = name
        self.launchedAt = launchedAt
        self.letter = LetterAssigner.dynamicLetter(for: name)
    }
}

/// Maps letters to apps: custom pins win, then dynamic first-letter matches.
struct LetterAssigner {
    /// letter → bundleID. Persisted via SettingsStore from Phase 2.
    var customAssignments: [Character: String] = [:]

    /// Apps owning `letter`, in cycle order: the pinned app first, then
    /// dynamic matches ordered by launch time. Launch order is the stability
    /// rule (BATTLEPLAN §3.4): the same letter must target the same app for as
    /// long as it stays running, never reshuffling with recent use. Apps
    /// pinned to some other letter never match dynamically.
    func apps(for letter: Character, in candidates: [AppCandidate]) -> [AppCandidate] {
        let pinnedID = customAssignments[letter]
        let pinned = candidates.filter { $0.bundleID == pinnedID }
        let dynamic = candidates.filter {
            $0.bundleID != pinnedID
                && $0.letter == letter
                && !customAssignments.values.contains($0.bundleID)
        }
        .sorted { ($0.launchedAt ?? .distantFuture) < ($1.launchedAt ?? .distantFuture) }
        return pinned + dynamic
    }

    /// First alphanumeric of the name, lowercased, diacritics folded
    /// ("Übersicht" → "u", "1Password" → "1"). Single source of the dynamic
    /// rule; AppCandidate stores the result.
    static func dynamicLetter(for name: String) -> Character? {
        name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            .first { $0.isLetter || $0.isNumber }
    }
}
