import XCTest
@testable import Starboard

@MainActor
final class SearchModelTests: XCTestCase {
    private let windows = [
        WindowInfo(id: 1, pid: 101, appName: "Safari", bundleID: "com.apple.Safari", title: "Release notes"),
        WindowInfo(id: 2, pid: 102, appName: "Notes", bundleID: "com.apple.Notes", title: "Roadmap"),
        WindowInfo(id: 3, pid: 103, appName: "Terminal", bundleID: "com.apple.Terminal", title: "starboard"),
    ]

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
