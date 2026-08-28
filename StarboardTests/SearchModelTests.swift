import XCTest
@testable import Starboard

@MainActor
final class SearchModelTests: XCTestCase {
    private let windows = [
        WindowInfo(id: 1, pid: 101, appName: "Safari", bundleID: "com.apple.Safari", title: "Release notes", isOnScreen: true),
        WindowInfo(id: 2, pid: 102, appName: "Notes", bundleID: "com.apple.Notes", title: "Roadmap", isOnScreen: false),
        WindowInfo(id: 3, pid: 103, appName: "Terminal", bundleID: "com.apple.Terminal", title: "starboard", isOnScreen: true),
    ]

    private let apps = [
        AppCandidate(bundleID: "com.apple.Safari", name: "Safari"),
        AppCandidate(bundleID: "com.apple.Notes", name: "Notes"),
        AppCandidate(bundleID: "com.apple.Terminal", name: "Terminal"),
    ]

    func testHoldListsLetterMapWithoutSelection() {
        let model = SearchModel(registry: AppRegistry(), searchWindows: { [] })
        model.beginHold(candidates: apps, assigner: LetterAssigner())

        XCTAssertTrue(model.isVisible)
        XCTAssertNil(model.selectedIndex)
        XCTAssertNil(model.selectedItem)
        XCTAssertEqual(model.items.map(\.title), ["Notes", "Safari", "Terminal"])
        XCTAssertEqual(model.items.map(\.letter), ["n", "s", "t"])
    }

    func testHoldLetterMapUsesPinnedLetters() {
        let model = SearchModel(registry: AppRegistry(), searchWindows: { [] })
        let assigner = LetterAssigner(customAssignments: ["k": "com.apple.Safari"])
        model.beginHold(candidates: apps, assigner: assigner)

        XCTAssertEqual(model.items.map(\.letter), ["k", "n", "t"])
        XCTAssertEqual(model.items.first?.title, "Safari")
    }

    func testArrowsSelectInTheLetterMap() {
        let model = SearchModel(registry: AppRegistry(), searchWindows: { [] })
        model.beginHold(candidates: apps, assigner: LetterAssigner())

        model.moveSelection(1)
        XCTAssertEqual(model.selectedIndex, 0)
        model.beginHold(candidates: apps, assigner: LetterAssigner())
        model.moveSelection(-1)
        XCTAssertEqual(model.selectedIndex, 2)
    }

    func testEmptyingTheQueryReturnsToTheLetterMap() {
        let model = SearchModel(registry: AppRegistry(), searchWindows: { [] })
        model.beginHold(candidates: apps, assigner: LetterAssigner())
        model.setQuery("saf")
        model.setQuery("")

        XCTAssertTrue(model.isVisible)
        XCTAssertNil(model.selectedIndex)
        XCTAssertEqual(model.items.map(\.letter), ["n", "s", "t"])
    }

    func testWindowSearchRanksAndResetsSelection() {
        let model = SearchModel(registry: AppRegistry(), searchWindows: { self.windows })
        model.beginWindowSearch()
        model.moveSelection(2)
        model.setQuery("road")

        XCTAssertEqual(model.items.first?.title, "Roadmap")
        XCTAssertEqual(model.selectedIndex, 0)
        XCTAssertTrue(model.isVisible)
    }

    func testWindowSelectionWraps() {
        let model = SearchModel(registry: AppRegistry(), searchWindows: { self.windows })
        model.beginWindowSearch()
        model.moveSelection(-1)
        XCTAssertEqual(model.selectedIndex, 2)
    }

    func testWindowSearchSeesMinimizedAndOtherSpaceWindows() {
        // The ring stays a Cmd-Tab replacement; search must still reach the
        // off-screen "Roadmap" window.
        let model = SearchModel(
            registry: AppRegistry(),
            ringWindows: { self.windows.filter(\.isOnScreen) },
            searchWindows: { self.windows }
        )
        model.beginWindowCycle()
        XCTAssertEqual(model.items.map(\.title), ["Release notes", "starboard"])

        model.setQuery("road")
        XCTAssertEqual(model.items.first?.title, "Roadmap")
    }

    func testEqualScoresRankRunningFirstThenMRUThenTitle() {
        let running = ["Slack", "Safari", "System Settings"].enumerated().map { index, name in
            SearchModel.Candidate(
                item: SearchModel.Item(
                    kind: .runningApp(bundleID: "app.\(name)"),
                    title: name,
                    subtitle: nil,
                    letter: "s"
                ),
                target: name,
                isRunning: true,
                order: index
            )
        }
        let closed = ["Stickies", "Script Editor"].map { name in
            SearchModel.Candidate(
                item: SearchModel.Item(
                    kind: .installedApp(bundleID: "installed.\(name)"),
                    title: name,
                    subtitle: "Launch",
                    letter: nil
                ),
                target: name,
                isRunning: false,
                order: .max
            )
        }
        // All five score identically on "s": MRU decides among the running
        // ones, title length then alphabet among the closed ones, and the
        // order must not depend on how the input was shuffled.
        let expected = ["Slack", "Safari", "System Settings", "Stickies", "Script Editor"]
        XCTAssertEqual(SearchModel.rank("s", candidates: running + closed).map(\.title), expected)
        XCTAssertEqual(SearchModel.rank("s", candidates: closed + running).map(\.title), expected)
    }

    func testCancelClearsWindowSearchState() {
        let model = SearchModel(registry: AppRegistry(), searchWindows: { self.windows })
        model.beginWindowSearch()
        model.cancel()
        XCTAssertFalse(model.isVisible)
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertEqual(model.scope, .apps)
    }
}
