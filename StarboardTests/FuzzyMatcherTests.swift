import XCTest
@testable import Starboard

final class FuzzyMatcherTests: XCTestCase {
    func testNoMatchReturnsNil() {
        XCTAssertNil(FuzzyMatcher.score(query: "xyz", target: "Safari"))
    }

    func testSubsequenceMatches() {
        XCTAssertNotNil(FuzzyMatcher.score(query: "sfr", target: "Safari"))
        XCTAssertNotNil(FuzzyMatcher.score(query: "XCO", target: "Xcode"))
    }

    func testStartOfStringBeatsMiddleMatch() {
        let start = FuzzyMatcher.score(query: "sa", target: "Safari")!
        let middle = FuzzyMatcher.score(query: "af", target: "Safari")!
        XCTAssertGreaterThan(start, middle)
    }

    func testWordBoundaryBonus() {
        // "p" at the start of "Point" (after space) beats "p" inside "App".
        let boundary = FuzzyMatcher.score(query: "sp", target: "Space Point")!
        let interior = FuzzyMatcher.score(query: "ap", target: "Paper App")!
        // Both are valid; boundary-heavy match should not lose to interior-only.
        XCTAssertGreaterThan(boundary, interior)
    }

    func testConsecutiveRunBeatsScattered() {
        let consecutive = FuzzyMatcher.score(query: "con", target: "Console")!
        let scattered = FuzzyMatcher.score(query: "con", target: "CaSe Of NothIng".lowercased())!
        XCTAssertGreaterThan(consecutive, scattered)
    }

    func testRankingTable() {
        let ranked = FuzzyMatcher.ranked(
            query: "xco",
            targets: ["Xcode", "Preview", "Coin X", "xcodes helper"]
        )
        XCTAssertEqual(ranked.first?.target, "Xcode")
    }

    func testDiacriticsFold() {
        XCTAssertNotNil(FuzzyMatcher.score(query: "ub", target: "Übersicht"))
    }
}
