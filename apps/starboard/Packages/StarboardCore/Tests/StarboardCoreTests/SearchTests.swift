@testable import StarboardCore
import Testing

struct FuzzyMatcherTests {
    private func match(_ query: String, _ title: String) -> FuzzyMatcher.Match? {
        FuzzyMatcher.match(FuzzyMatcher.fold(query), in: title)
    }

    private func score(_ query: String, _ title: String) -> Int? {
        match(query, title)?.score
    }

    @Test func aSubsequenceMatchesAndAnythingElseDoesNot() {
        #expect(score("sfr", "Safari") != nil)
        #expect(score("XCO", "Xcode") != nil)
        #expect(score("xyz", "Safari") == nil)
        #expect(score("xco", "Coin X") == nil)
    }

    @Test func theStartOfTheTitleBeatsTheMiddle() throws {
        #expect(try #require(score("sa", "Safari")) > #require(score("af", "Safari")))
    }

    @Test func wordBoundariesBeatInteriorMatches() throws {
        #expect(try #require(score("sp", "Space Point")) > #require(score("ap", "Paper App")))
    }

    @Test func aConsecutiveRunBeatsAScatteredOne() throws {
        #expect(try #require(score("con", "Console")) > #require(score("con", "case of nothing")))
    }

    @Test func diacriticsFold() {
        #expect(score("ub", "Übersicht") != nil)
    }

    @Test func matchedIndicesPointAtTheTitle() {
        #expect(match("xco", "Xcode")?.matchedIndices == [0, 1, 2])
        #expect(match("sfr", "Safari")?.matchedIndices == [0, 2, 4])
        #expect(match("se", "Straße")?.matchedIndices == [0, 5])
    }
}

struct SearchRankingTests {
    @Test func equalScoresRankRunningThenRecentThenShortThenAlphabetical() {
        let running = ["Slack", "Safari", "System Settings"].enumerated().map { index, name in
            SearchCandidate(bundleID: name, title: name, isRunning: true, order: index)
        }
        let closed = ["Stickies", "Script Editor"].map { name in
            SearchCandidate(bundleID: name, title: name, isRunning: false, order: .max)
        }
        let expected = ["Slack", "Safari", "System Settings", "Stickies", "Script Editor"]
        #expect(Search.rank("s", in: running + closed).map(\.candidate.title) == expected)
        #expect(Search.rank("s", in: closed + running).map(\.candidate.title) == expected)
    }

    @Test func aBetterScoreBeatsRecency() {
        let candidates = [
            SearchCandidate(bundleID: "a", title: "Mail", isRunning: true, order: 0),
            SearchCandidate(bundleID: "b", title: "Xcode", isRunning: false, order: .max),
        ]
        #expect(Search.rank("xc", in: candidates).map(\.candidate.title) == ["Xcode"])
    }
}
