import XCTest

final class PreferencesTests: XCTestCase {
    func testPartialDocumentKeepsDefaultsForMissingKeys() throws {
        let json = """
        {"version": 1, "hud": {"enabled": false}, "agents": {"claudeEnabled": true, "unknownKey": 3}}
        """
        let decoded = try Preferences.decode(Data(json.utf8))

        XCTAssertFalse(decoded.hud.enabled)
        XCTAssertTrue(decoded.hud.replacesSystem == Preferences().hud.replacesSystem)
        XCTAssertTrue(decoded.agents.claudeEnabled)
        XCTAssertTrue(decoded.agents.notifyAttention, "untouched sibling keeps its default")
        XCTAssertEqual(decoded.tray.ttlDays, 7)
    }

    func testLegacyDefaultsImportMapsEveryGroup() {
        let defaults = UserDefaults(suiteName: "PreferencesTests.\(UUID().uuidString)")!
        defaults.set(false, forKey: "showHUD")
        defaults.set("inside", forKey: "tabBarStyle")
        defaults.set(["battery", "note"], forKey: "widgetLayout")
        defaults.set("all", forKey: "displayPlacement")
        defaults.set(3, forKey: "trayTTLDays")
        defaults.set("fahrenheit", forKey: "temperatureUnit")
        defaults.set(true, forKey: "agentClaudeEnabled")
        defaults.set("Glass", forKey: "agentSoundStarted")

        let imported = Preferences.importingLegacyDefaults(defaults)

        XCTAssertFalse(imported.hud.enabled)
        XCTAssertEqual(imported.notch.tabBarStyle, .inside)
        XCTAssertEqual(imported.notch.widgetLayout, [.battery, .note])
        XCTAssertEqual(imported.display.placement, .all)
        XCTAssertEqual(imported.tray.ttlDays, 3)
        XCTAssertEqual(imported.widgets.temperatureUnit, .fahrenheit)
        XCTAssertTrue(imported.agents.claudeEnabled)
        XCTAssertEqual(imported.agents.soundStarted, "Complete", "legacy system sound names map to the palette")
        XCTAssertTrue(imported.notch.tabLayout.contains(.home))
    }

    func testRoundTripThroughEncoder() throws {
        var prefs = Preferences()
        prefs.display.placement = .all
        prefs.agents.t3Environments = [T3Environment(id: "e1", label: "Laptop", baseURL: "http://localhost:1")]

        let data = try JSONEncoder().encode(prefs)
        XCTAssertEqual(try Preferences.decode(data), prefs)
    }
}
