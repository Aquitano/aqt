@testable import Starboard
import XCTest

@MainActor
final class StageRestoreTests: XCTestCase {
    private let stage = Stage(
        name: "Work",
        letter: "w",
        apps: [StageApp(bundleID: "app.one"), StageApp(bundleID: "app.two")]
    )

    func testAllAppsRunningUsesActivateMode() {
        XCTAssertEqual(
            StagesController.restoreMode(for: stage, runningBundleIDs: ["app.one", "app.two", "intruder"]),
            .activate
        )
    }

    func testMissingAppUsesFullRestoreMode() {
        XCTAssertEqual(
            StagesController.restoreMode(for: stage, runningBundleIDs: ["app.one"]),
            .fullRestore
        )
    }
}
