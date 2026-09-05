@testable import Starboard
import XCTest

final class FuzzyMatcherTests: XCTestCase {
    func testNoMatchReturnsNil() {
        XCTAssertNil(FuzzyMatcher.score(query: "xyz", target: "Safari"))
    }

    func testSubsequenceMatches() {
        XCTAssertNotNil(FuzzyMatcher.score(query: "sfr", target: "Safari"))
        XCTAssertNotNil(FuzzyMatcher.score(query: "XCO", target: "Xcode"))
    }

    func testStartOfStringBeatsMiddleMatch() throws {
        let start = try XCTUnwrap(FuzzyMatcher.score(query: "sa", target: "Safari"))
        let middle = try XCTUnwrap(FuzzyMatcher.score(query: "af", target: "Safari"))
        XCTAssertGreaterThan(start, middle)
    }

    func testWordBoundaryBonus() throws {
        // "p" at the start of "Point" (after space) beats "p" inside "App".
        let boundary = try XCTUnwrap(FuzzyMatcher.score(query: "sp", target: "Space Point"))
        let interior = try XCTUnwrap(FuzzyMatcher.score(query: "ap", target: "Paper App"))
        // Both are valid; boundary-heavy match should not lose to interior-only.
        XCTAssertGreaterThan(boundary, interior)
    }

    func testConsecutiveRunBeatsScattered() throws {
        let consecutive = try XCTUnwrap(FuzzyMatcher.score(query: "con", target: "Console"))
        let scattered = try XCTUnwrap(FuzzyMatcher.score(query: "con", target: "CaSe Of NothIng".lowercased()))
        XCTAssertGreaterThan(consecutive, scattered)
    }

    func testPrefixBeatsScatteredAndSuffixMatches() throws {
        let exact = try XCTUnwrap(FuzzyMatcher.score(query: "xco", target: "Xcode"))
        let scattered = FuzzyMatcher.score(query: "xco", target: "Coin X".lowercased())
        let suffixed = try XCTUnwrap(FuzzyMatcher.score(query: "xco", target: "xcodes helper"))
        XCTAssertNil(scattered)
        XCTAssertGreaterThanOrEqual(exact, suffixed)
    }

    func testDiacriticsFold() {
        XCTAssertNotNil(FuzzyMatcher.score(query: "ub", target: "Übersicht"))
    }

    func testMatchReturnsCorrectCharacterIndices() {
        let matchXcode = FuzzyMatcher.match(query: "xco", target: "Xcode")
        XCTAssertNotNil(matchXcode)
        XCTAssertEqual(matchXcode?.matchedIndices, [0, 1, 2])

        let matchSafari = FuzzyMatcher.match(query: "sfr", target: "Safari")
        XCTAssertNotNil(matchSafari)
        XCTAssertEqual(matchSafari?.matchedIndices, [0, 2, 4])
    }
}
