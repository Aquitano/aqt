import Foundation

/// Pure subsequence fuzzy scorer. nil means "no match". Higher is better.
/// Bonuses: start-of-string, word-boundary, consecutive runs; small gap penalty
/// so tighter matches rank higher (BATTLEPLAN Phase 3).
enum FuzzyMatcher {
    static func score(query: String, target: String) -> Int? {
        let q = query.lowercased().folding(options: [.diacriticInsensitive], locale: nil)
        let t = target.lowercased().folding(options: [.diacriticInsensitive], locale: nil)
        guard !q.isEmpty else { return 0 }
        let tChars = Array(t)
        var score = 0
        var searchStart = 0
        var lastMatchIndex: Int?

        for qc in q {
            guard let index = firstOccurrence(qc, in: tChars, after: searchStart) else { return nil }

            if index == 0 {
                score += 8 // start of string
            } else if !isAlphanumeric(tChars[index - 1]) {
                score += 6 // word boundary
            }
            if lastMatchIndex == index - 1 {
                score += 5 // consecutive run
            }
            if let last = lastMatchIndex {
                score -= min(index - last - 1, 5) // gap penalty, capped
            }
            score += 10

            lastMatchIndex = index
            searchStart = index + 1
        }
        return score
    }

    private static func firstOccurrence(_ char: Character, in chars: [Character], after start: Int) -> Int? {
        for i in start..<chars.count where chars[i] == char {
            return i
        }
        return nil
    }

    private static func isAlphanumeric(_ char: Character) -> Bool {
        char.isLetter || char.isNumber
    }
}
