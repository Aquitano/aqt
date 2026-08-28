import XCTest
@testable import Starboard

final class SettingsStoreTests: XCTestCase {
    private func makeStore() -> (SettingsStore, UserDefaults) {
        let suite = "test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (SettingsStore(defaults: defaults), defaults)
    }

    func testDefaultsRoundTrip() throws {
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
        let defaults = UserDefaults(suiteName: suite)!
        // A model persisted by a newer version with extra fields still loads.
        let futureJSON = #"{"repeatPress":"cycleWindows","launchIfNotRunning":false,"customAssignments":{"s":"com.apple.Safari"},"someFutureField":42}"#
        defaults.set(Data(futureJSON.utf8), forKey: "starboard.settings")

        let store = SettingsStore(defaults: defaults)
        XCTAssertEqual(store.model.customAssignments["s"], "com.apple.Safari")
    }

    func testMissingFieldsDecodeToDefaults() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        // A model persisted before newer fields existed still loads, keeping
        // the user's data and defaulting the rest (no silent settings wipe).
        let oldJSON = #"{"customAssignments":{"s":"com.apple.Safari"}}"#
        defaults.set(Data(oldJSON.utf8), forKey: "starboard.settings")

        let store = SettingsStore(defaults: defaults)
        XCTAssertEqual(store.model.customAssignments["s"], "com.apple.Safari")
        XCTAssertEqual(store.model.repeatPress, .cycleWindows)
        XCTAssertFalse(store.model.windowJumpEnabled)
    }

    func testWritesAreCoalescedUntilFlush() throws {
        let (store, defaults) = makeStore()
        store.model.windowJumpEnabled = true
        XCTAssertNil(defaults.data(forKey: "starboard.settings"))

        store.flush()
        XCTAssertNotNil(defaults.data(forKey: "starboard.settings"))
    }
}
