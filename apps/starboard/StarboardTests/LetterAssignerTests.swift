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

    func testDynamicWinnerIsStableByLaunchOrderNotListOrder() {
        let assigner = LetterAssigner()
        let vlc = AppCandidate(bundleID: "org.videolan.vlc", name: "VLC", launchedAt: Date(timeIntervalSince1970: 200))
        let vivaldi = AppCandidate(bundleID: "com.vivaldi.Vivaldi", name: "Vivaldi", launchedAt: Date(timeIntervalSince1970: 100))
        // Whatever order MRU hands us, the earlier-launched app owns the
        // letter for as long as both run (BATTLEPLAN §3.4 stability).
        XCTAssertEqual(assigner.apps(for: "v", in: [vlc, vivaldi]).first?.name, "Vivaldi")
        XCTAssertEqual(assigner.apps(for: "v", in: [vivaldi, vlc]).first?.name, "Vivaldi")
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
