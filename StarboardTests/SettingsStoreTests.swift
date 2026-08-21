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
        store.model.hideOnRepeat = false

        let reloaded = SettingsStore(defaults: defaults)
        XCTAssertEqual(reloaded.model.customAssignments["k"], "com.tinyspeck.slackmacgap")
        XCTAssertFalse(reloaded.model.hideOnRepeat)
    }

    func testUnknownFieldsDecodeGracefully() throws {
        let suite = "test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        // A model persisted by a newer version with extra fields still loads.
        let futureJSON = #"{"hideOnRepeat":true,"launchIfNotRunning":false,"customAssignments":{"s":"com.apple.Safari"},"someFutureField":42}"#
        defaults.set(Data(futureJSON.utf8), forKey: "starboard.settings")

        let store = SettingsStore(defaults: defaults)
        XCTAssertEqual(store.model.customAssignments["s"], "com.apple.Safari")
    }
}
