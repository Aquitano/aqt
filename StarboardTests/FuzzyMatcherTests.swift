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

    func testPrefixBeatsScatteredAndSuffixMatches() {
        let exact = FuzzyMatcher.score(query: "xco", target: "Xcode")!
        let scattered = FuzzyMatcher.score(query: "xco", target: "Coin X".lowercased())
        let suffixed = FuzzyMatcher.score(query: "xco", target: "xcodes helper")!
        XCTAssertNil(scattered)
        XCTAssertGreaterThanOrEqual(exact, suffixed)
    }

    func testDiacriticsFold() {
        XCTAssertNotNil(FuzzyMatcher.score(query: "ub", target: "Übersicht"))
    }
}
