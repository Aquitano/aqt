import Foundation
@testable import NotchCore
import Testing

struct PreferencesTests {
    @Test func partialDocumentKeepsDefaultsForMissingKeys() throws {
        let json = """
        {"version": 1, "hud": {"enabled": false}, "agents": {"claudeEnabled": true, "unknownKey": 3}}
        """
        let decoded = try Preferences.decode(Data(json.utf8))

        #expect(!decoded.hud.enabled)
        #expect(decoded.hud.replacesSystem == Preferences().hud.replacesSystem)
        #expect(decoded.agents.claudeEnabled)
        #expect(decoded.agents.notifyAttention, "untouched sibling keeps its default")
        #expect(decoded.tray.ttlDays == 7)
    }

    @Test func legacyDefaultsImportMapsEveryGroup() throws {
        let defaults = try #require(UserDefaults(suiteName: "PreferencesTests.\(UUID().uuidString)"))
        defaults.set(false, forKey: "showHUD")
        defaults.set("inside", forKey: "tabBarStyle")
        defaults.set(["battery", "note"], forKey: "widgetLayout")
        defaults.set("all", forKey: "displayPlacement")
        defaults.set(3, forKey: "trayTTLDays")
        defaults.set("fahrenheit", forKey: "temperatureUnit")
        defaults.set(true, forKey: "agentClaudeEnabled")
        defaults.set("Glass", forKey: "agentSoundStarted")

        let imported = Preferences.importingLegacyDefaults(defaults)

        #expect(!imported.hud.enabled)
        #expect(imported.notch.tabBarStyle == .inside)
        #expect(imported.notch.widgetLayout == [.battery, .note])
        #expect(imported.display.placement == .all)
        #expect(imported.tray.ttlDays == 3)
        #expect(imported.widgets.temperatureUnit == .fahrenheit)
        #expect(imported.agents.claudeEnabled)
        #expect(imported.agents.soundStarted == "Complete", "legacy system sound names map to the palette")
        #expect(imported.notch.tabLayout.contains(.home))
    }

    @Test func roundTripThroughEncoder() throws {
        var prefs = Preferences()
        prefs.display.placement = .all
        prefs.agents.t3Environments = [T3Environment(id: "e1", label: "Laptop", baseURL: "http://localhost:1")]

        let data = try JSONEncoder().encode(prefs)
        #expect(try Preferences.decode(data) == prefs)
    }
}
