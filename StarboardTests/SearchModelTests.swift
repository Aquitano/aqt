import XCTest
@testable import Starboard

@MainActor
final class SearchModelTests: XCTestCase {
    private let windows = [
        WindowInfo(id: 1, pid: 101, appName: "Safari", bundleID: "com.apple.Safari", title: "Release notes"),
        WindowInfo(id: 2, pid: 102, appName: "Notes", bundleID: "com.apple.Notes", title: "Roadmap"),
        WindowInfo(id: 3, pid: 103, appName: "Terminal", bundleID: "com.apple.Terminal", title: "starboard"),
    ]

    private let apps = [
        AppCandidate(bundleID: "com.apple.Safari", name: "Safari"),
        AppCandidate(bundleID: "com.apple.Notes", name: "Notes"),
        AppCandidate(bundleID: "com.apple.Terminal", name: "Terminal"),
    ]

    func testHoldListsLetterMapWithoutSelection() {
        let model = SearchModel(registry: AppRegistry(), windowProvider: { [] })
        model.beginHold(candidates: apps, assigner: LetterAssigner())

        XCTAssertTrue(model.isVisible)
        XCTAssertNil(model.selectedIndex)
        XCTAssertNil(model.selectedItem)
        XCTAssertEqual(model.items.map(\.title), ["Notes", "Safari", "Terminal"])
        XCTAssertEqual(model.items.map(\.letter), ["n", "s", "t"])
    }

    func testHoldLetterMapUsesPinnedLetters() {
        let model = SearchModel(registry: AppRegistry(), windowProvider: { [] })
        let assigner = LetterAssigner(customAssignments: ["k": "com.apple.Safari"])
        model.beginHold(candidates: apps, assigner: assigner)

        XCTAssertEqual(model.items.map(\.letter), ["k", "n", "t"])
        XCTAssertEqual(model.items.first?.title, "Safari")
    }

    func testArrowsSelectInTheLetterMap() {
        let model = SearchModel(registry: AppRegistry(), windowProvider: { [] })
        model.beginHold(candidates: apps, assigner: LetterAssigner())

        model.moveSelection(1)
        XCTAssertEqual(model.selectedIndex, 0)
        model.beginHold(candidates: apps, assigner: LetterAssigner())
        model.moveSelection(-1)
        XCTAssertEqual(model.selectedIndex, 2)
    }

    func testEmptyingTheQueryReturnsToTheLetterMap() {
        let model = SearchModel(registry: AppRegistry(), windowProvider: { [] })
        model.beginHold(candidates: apps, assigner: LetterAssigner())
        model.setQuery("saf")
        model.setQuery("")

        XCTAssertTrue(model.isVisible)
        XCTAssertNil(model.selectedIndex)
        XCTAssertEqual(model.items.map(\.letter), ["n", "s", "t"])
    }

    func testWindowSearchRanksAndResetsSelection() {
        let model = SearchModel(registry: AppRegistry(), windowProvider: { self.windows })
        model.beginWindowSearch()
        model.moveSelection(2)
        model.setQuery("road")

        XCTAssertEqual(model.items.first?.title, "Roadmap")
        XCTAssertEqual(model.selectedIndex, 0)
        XCTAssertTrue(model.isVisible)
    }

    func testWindowSelectionWraps() {
        let model = SearchModel(registry: AppRegistry(), windowProvider: { self.windows })
        model.beginWindowSearch()
        model.moveSelection(-1)
        XCTAssertEqual(model.selectedIndex, 2)
    }

    func testCancelClearsWindowSearchState() {
        let model = SearchModel(registry: AppRegistry(), windowProvider: { self.windows })
        model.beginWindowSearch()
        model.cancel()
        XCTAssertFalse(model.isVisible)
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertEqual(model.scope, .apps)
    }
}
