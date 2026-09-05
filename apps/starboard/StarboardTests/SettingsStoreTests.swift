@testable import Starboard
import XCTest

final class SettingsStoreTests: XCTestCase {
    private func makeStore() -> (SettingsStore, UserDefaults) {
        let suite = "test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (SettingsStore(defaults: defaults), defaults)
    }

    func testDefaultsRoundTrip() {
        let (store, defaults) = makeStore()
        store.model.customAssignments["k"] = "com.tinyspeck.slackmacgap"
        store.model.repeatPress = .hide
        store.flush()

        let reloaded = SettingsStore(defaults: defaults)
        XCTAssertEqual(reloaded.model.customAssignments["k"], "com.tinyspeck.slackmacgap")
        XCTAssertEqual(reloaded.model.repeatPress, .hide)
    }

    func testUnknownFieldsDecodeGracefully() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        // A model persisted by a newer version with extra fields still loads.
        let futureJSON = #"{"repeatPress":"cycleWindows","launchIfNotRunning":false,"customAssignments":{"s":"com.apple.Safari"},"someFutureField":42}"#
        defaults.set(Data(futureJSON.utf8), forKey: "starboard.settings")

        let store = SettingsStore(defaults: defaults)
        XCTAssertEqual(store.model.customAssignments["s"], "com.apple.Safari")
    }

    func testMissingFieldsDecodeToDefaults() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        // A model persisted before newer fields existed still loads, keeping
        // the user's data and defaulting the rest (no silent settings wipe).
        let oldJSON = #"{"customAssignments":{"s":"com.apple.Safari"}}"#
        defaults.set(Data(oldJSON.utf8), forKey: "starboard.settings")

        let store = SettingsStore(defaults: defaults)
        XCTAssertEqual(store.model.customAssignments["s"], "com.apple.Safari")
        XCTAssertEqual(store.model.repeatPress, .cycleWindows)
        XCTAssertFalse(store.model.windowJumpEnabled)
    }

    func testWritesAreCoalescedUntilFlush() {
        let (store, defaults) = makeStore()
        store.model.windowJumpEnabled = true
        XCTAssertNil(defaults.data(forKey: "starboard.settings"))

        store.flush()
        XCTAssertNotNil(defaults.data(forKey: "starboard.settings"))
    }

    func testNewSettingsFieldsRoundTripAndDefault() {
        let (store, defaults) = makeStore()
        XCTAssertEqual(store.model.primaryModifier, .rightCommand)
        XCTAssertEqual(store.model.holdOverlayDelayMs, 300)
        XCTAssertEqual(store.model.excludedBundleIDs, [])

        store.model.primaryModifier = .rightOption
        store.model.holdOverlayDelayMs = 200
        store.model.excludedBundleIDs = ["com.docker.docker", "com.tinyspeck.slackmacgap"]
        store.flush()

        let reloaded = SettingsStore(defaults: defaults)
        XCTAssertEqual(reloaded.model.primaryModifier, .rightOption)
        XCTAssertEqual(reloaded.model.holdOverlayDelayMs, 200)
        XCTAssertEqual(reloaded.model.excludedBundleIDs, ["com.docker.docker", "com.tinyspeck.slackmacgap"])
    }

    func testHoldOverlayDelayMsIsClamped() {
        let (store, defaults) = makeStore()
        store.model.holdOverlayDelayMs = -50
        XCTAssertEqual(store.model.holdOverlayDelayMs, 50)

        store.model.holdOverlayDelayMs = 50000
        XCTAssertEqual(store.model.holdOverlayDelayMs, 2000)

        let badJSON = #"{"holdOverlayDelayMs": -999}"#
        defaults.set(Data(badJSON.utf8), forKey: "starboard.settings")
        let reloaded = SettingsStore(defaults: defaults)
        XCTAssertEqual(reloaded.model.holdOverlayDelayMs, 50)
    }
}

final class SettingsStoreFileTests: XCTestCase {
    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("starboard-\(UUID().uuidString)")
            .appendingPathComponent("settings.json")
    }

    func testFileBackedStoreWritesAndReloadsExternalEdits() throws {
        let url = temporaryURL()
        let store = SettingsStore(storage: .file(url))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        store.model.customAssignments["k"] = "com.tinyspeck.slackmacgap"
        store.flush()
        let persisted = try JSONDecoder().decode(SettingsStore.Model.self, from: Data(contentsOf: url))
        XCTAssertEqual(persisted.customAssignments["k"], "com.tinyspeck.slackmacgap")

        // The Raycast extension edits the file in place; the running helper
        // must pick that up without being told.
        var external = persisted
        external.repeatPress = .hide
        try JSONEncoder().encode(external).write(to: url)

        let reloaded = expectation(description: "reload")
        _ = withObservationTracking { store.model.repeatPress } onChange: { reloaded.fulfill() }
        wait(for: [reloaded], timeout: 2)
        XCTAssertEqual(store.model.repeatPress, .hide)
    }
}
