import XCTest
@testable import Starboard

final class LetterAssignerTests: XCTestCase {
    func testDynamicLetterFoldsDiacriticsAndCase() {
        XCTAssertEqual(LetterAssigner.dynamicLetter(for: "Übersicht"), "u")
        XCTAssertEqual(LetterAssigner.dynamicLetter(for: "Safari"), "s")
        XCTAssertEqual(LetterAssigner.dynamicLetter(for: "1Password"), "1")
    }

    func testCustomAssignmentWinsOverDynamic() {
        var assigner = LetterAssigner()
        assigner.customAssignments["s"] = "com.tinyspeck.slackmacgap"
        let apps = [
            AppCandidate(bundleID: "com.apple.Safari", name: "Safari"),
            AppCandidate(bundleID: "com.tinyspeck.slackmacgap", name: "Slack"),
        ]
        let matches = assigner.apps(for: "s", in: apps)
        XCTAssertEqual(matches.map(\.name), ["Slack", "Safari"])
    }

    func testPinnedElsewhereIsExcludedFromDynamicMatches() {
        var assigner = LetterAssigner()
        assigner.customAssignments["k"] = "com.tinyspeck.slackmacgap"
        let apps = [
            AppCandidate(bundleID: "com.apple.Safari", name: "Safari"),
            AppCandidate(bundleID: "com.tinyspeck.slackmacgap", name: "Slack"),
        ]
        XCTAssertEqual(assigner.apps(for: "s", in: apps).map(\.name), ["Safari"])
    }
}
