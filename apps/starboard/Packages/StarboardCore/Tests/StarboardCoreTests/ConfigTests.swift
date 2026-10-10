import Foundation
@testable import StarboardCore
import Testing

struct ConfigTests {
    private func decode(_ json: String) -> Result<Config, ConfigError> {
        Config.decode(Data(json.utf8))
    }

    @Test func missingKeysTakeTheirDefaults() throws {
        let config = try decode(#"{"assignments": {"c": "Google Chrome"}}"#).get()
        var expected = Config()
        expected.assignments = ["c": "Google Chrome"]
        #expect(config == expected)
    }

    @Test func theDefaultsRoundTrip() throws {
        var config = Config()
        config.stages = [Stage(letter: "w", name: "Writing", apps: [StageApp(app: "Notes", open: ["~/notes.md"])])]
        #expect(try Config.decode(config.encoded()).get() == config)
    }

    @Test func anUnknownKeyIsAnError() {
        #expect(decode(#"{"asignments": {}}"#) == .failure(ConfigError(message: "asignments: unknown key")))
        #expect(
            decode(#"{"stages": [{"letter": "w", "apps": [{"app": "Notes", "opne": []}]}]}"#)
                == .failure(ConfigError(message: "stages[0].apps[0].opne: unknown key"))
        )
    }

    @Test func aWrongTypeNamesItsPath() throws {
        let error = try #require(decode(#"{"overlayDelayMs": "fast"}"#).failure)
        #expect(error.message.hasPrefix("overlayDelayMs: "))
    }

    @Test func anUnknownEnumValueIsAnError() {
        #expect(decode(#"{"repeatPress": "hidee"}"#).failure != nil)
    }

    @Test func brokenJSONIsAnError() {
        #expect(decode(#"{"assignments": "#).failure != nil)
    }

    @Test func assignmentsTakeSingleLettersOnce() {
        #expect(decode(#"{"assignments": {"cc": "Chrome"}}"#).failure != nil)
        #expect(decode(#"{"assignments": {"1": "1Password"}}"#).failure != nil)
        #expect(decode(#"{"assignments": {"c": "Chrome", "C": "Calendar"}}"#).failure != nil)
    }

    @Test func theOverlayDelayIsBounded() {
        #expect(decode(#"{"overlayDelayMs": 10}"#).failure != nil)
        #expect(decode(#"{"overlayDelayMs": 150}"#).failure == nil)
    }

    @Test func stageLettersAreUnique() {
        let json = #"{"stages": [{"letter": "w", "apps": []}, {"letter": "W", "apps": []}]}"#
        #expect(decode(json).failure != nil)
    }

    @Test func pinningMovesAnAppOffItsOldLetter() {
        var config = Config()
        config.assignments = ["g": "Google Chrome", "t": "Ghostty"]
        config.pin("c", to: "google chrome")
        #expect(config.assignments == ["c": "google chrome", "t": "Ghostty"])
    }
}

struct ResolutionTests {
    private let apps = [
        AppRecord(bundleID: "com.google.Chrome", names: ["Google Chrome"]),
        AppRecord(bundleID: "com.mitchellh.ghostty", names: ["Ghostty"]),
    ]

    @Test func namesAndBundleIDsBothResolve() {
        var config = Config()
        config.assignments = ["c": "google chrome", "G": "com.mitchellh.ghostty"]
        config.excluded = ["Ghostty"]
        let resolution = config.resolve(in: apps)
        #expect(resolution.pins == ["c": "com.google.Chrome", "g": "com.mitchellh.ghostty"])
        #expect(resolution.excluded == ["com.mitchellh.ghostty"])
        #expect(resolution.unresolved.isEmpty)
    }

    @Test func unknownNamesAreReported() {
        var config = Config()
        config.assignments = ["c": "Chorme"]
        config.excluded = ["Nothing"]
        let resolution = config.resolve(in: apps)
        #expect(resolution.pins.isEmpty)
        #expect(resolution.unresolved == ["Chorme", "Nothing"])
    }
}

private extension Result {
    var failure: Failure? {
        guard case let .failure(error) = self else { return nil }
        return error
    }
}
