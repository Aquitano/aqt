import Foundation

public struct SearchCandidate: Equatable, Sendable {
    public let bundleID: String
    public let title: String
    /// Closed apps never outrank a running one with the same score.
    public let isRunning: Bool
    /// Recency among running apps; lower is more recent.
    public let order: Int

    public init(bundleID: String, title: String, isRunning: Bool, order: Int) {
        self.bundleID = bundleID
        self.title = title
        self.isRunning = isRunning
        self.order = order
    }
}

public struct SearchResult: Equatable, Sendable {
    public let candidate: SearchCandidate
    /// Character offsets into the title that the query matched.
    public let matchedIndices: [Int]
}

public enum Search {
    /// Score, then running before closed, then recency, then shorter title,
    /// then alphabetical. Every key is total, so rows with equal scores keep
    /// their order from one keystroke to the next.
    public static func rank(_ query: String, in candidates: [SearchCandidate]) -> [SearchResult] {
        let query = FuzzyMatcher.fold(query)
        return candidates
            .compactMap { candidate in
                FuzzyMatcher.match(query, in: candidate.title).map {
                    Hit(candidate: candidate, match: $0, length: candidate.title.count)
                }
            }
            .sorted(by: Hit.ranksBefore)
            .map { SearchResult(candidate: $0.candidate, matchedIndices: $0.match.matchedIndices) }
    }

    /// The title length is kept because `String.count` walks the whole title,
    /// and sorting would otherwise do that on every comparison.
    private struct Hit {
        let candidate: SearchCandidate
        let match: FuzzyMatcher.Match
        let length: Int

        static func ranksBefore(_ lhs: Hit, _ rhs: Hit) -> Bool {
            if lhs.match.score != rhs.match.score {
                return lhs.match.score > rhs.match.score
            }
            if lhs.candidate.isRunning != rhs.candidate.isRunning {
                return lhs.candidate.isRunning
            }
            if lhs.candidate.order != rhs.candidate.order {
                return lhs.candidate.order < rhs.candidate.order
            }
            if lhs.length != rhs.length {
                return lhs.length < rhs.length
            }
            return lhs.candidate.title < rhs.candidate.title
        }
    }
}

/// Subsequence matching with bonuses for the start of the string, word
/// boundaries and consecutive runs, and a capped penalty for gaps.
enum FuzzyMatcher {
    struct Match: Equatable {
        let score: Int
        let matchedIndices: [Int]
    }

    /// `query` comes from `fold`, once per search rather than per candidate.
    static func match(_ query: [Character], in title: String) -> Match? {
        let target = fold(title)
        guard !query.isEmpty else { return Match(score: 0, matchedIndices: []) }

        var score = 0
        var searchStart = 0
        var lastMatch: Int?
        var matchedIndices: [Int] = []

        for character in query {
            guard let index = target[searchStart...].firstIndex(of: character) else { return nil }
            if index == 0 {
                score += 8
            } else if !isAlphanumeric(target[index - 1]) {
                score += 6
            }
            if let lastMatch {
                if lastMatch == index - 1 {
                    score += 5
                }
                score -= min(index - lastMatch - 1, 5)
            }
            score += 10
            matchedIndices.append(index)
            lastMatch = index
            searchStart = index + 1
        }
        return Match(score: score, matchedIndices: matchedIndices)
    }

    /// Lowercasing rather than case folding: folding turns "ß" into "ss",
    /// which would shift the matched offsets off the title's characters.
    static func fold(_ text: String) -> [Character] {
        Array(text.lowercased().folding(options: [.diacriticInsensitive], locale: nil))
    }

    private static func isAlphanumeric(_ character: Character) -> Bool {
        character.isLetter || character.isNumber
    }
}
