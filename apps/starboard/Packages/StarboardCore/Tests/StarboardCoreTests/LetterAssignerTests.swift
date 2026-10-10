import Foundation
@testable import StarboardCore
import Testing

struct LetterAssignerTests {
    private let safari = AppCandidate(bundleID: "com.apple.Safari", name: "Safari")
    private let slack = AppCandidate(bundleID: "com.tinyspeck.slackmacgap", name: "Slack")
    private let notes = AppCandidate(bundleID: "com.apple.Notes", name: "Notes")

    @Test func theDynamicLetterFoldsDiacriticsAndCase() {
        #expect(LetterAssigner.dynamicLetter(for: "Übersicht") == "u")
        #expect(LetterAssigner.dynamicLetter(for: "Safari") == "s")
        #expect(LetterAssigner.dynamicLetter(for: "1Password") == "1")
    }

    @Test func aPinComesFirstOnItsLetter() {
        let assigner = LetterAssigner(pins: ["s": slack.bundleID])
        #expect(assigner.apps(for: "s", in: [safari, slack]).map(\.name) == ["Slack", "Safari"])
    }

    @Test func anAppPinnedElsewhereLeavesItsNameLetter() {
        let assigner = LetterAssigner(pins: ["k": slack.bundleID])
        #expect(assigner.apps(for: "s", in: [safari, slack]).map(\.name) == ["Safari"])
        #expect(assigner.apps(for: "k", in: [safari, slack]).map(\.name) == ["Slack"])
    }

    @Test func theEarlierLaunchedAppKeepsTheLetter() {
        let vlc = AppCandidate(bundleID: "org.videolan.vlc", name: "VLC", launchedAt: Date(timeIntervalSince1970: 200))
        let vivaldi = AppCandidate(
            bundleID: "com.vivaldi.Vivaldi",
            name: "Vivaldi",
            launchedAt: Date(timeIntervalSince1970: 100)
        )
        let assigner = LetterAssigner()
        #expect(assigner.apps(for: "v", in: [vlc, vivaldi]).first?.name == "Vivaldi")
        #expect(assigner.apps(for: "v", in: [vivaldi, vlc]).first?.name == "Vivaldi")
    }

    @Test func lettersFollowPins() {
        let assigner = LetterAssigner(pins: ["k": safari.bundleID])
        let candidates = [safari, slack, notes]
        #expect(assigner.letterMap(candidates).map(\.letter) == ["k", "n", "s"])
        #expect(assigner.letters(candidates) == [
            safari.bundleID: "k",
            slack.bundleID: "s",
            notes.bundleID: "n",
        ])
    }

    @Test func anAppOnlyReachedByCyclingHasNoLetter() {
        let assigner = LetterAssigner(pins: ["s": slack.bundleID])
        #expect(assigner.letters([safari, slack])[safari.bundleID] == nil)
    }
}
