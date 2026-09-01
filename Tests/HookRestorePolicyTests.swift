import XCTest

/// The throttle that decides whether a hook removal is repaired now. Table-driven
/// over the two rules: one repair per minute, and a hard stop after three in an hour.
final class HookRestorePolicyTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func ago(_ seconds: TimeInterval) -> Date { now.addingTimeInterval(-seconds) }

    func testDecision() {
        let cases: [(name: String, restores: [Date], expected: HookRestorePolicy.Decision)] = [
            ("first ever removal restores", [], .restore),
            ("within a minute of the last repair holds off", [ago(30)], .holdOff),
            ("a minute after the last repair restores again", [ago(60)], .restore),
            ("two recent repairs still leave one allowance", [ago(3000), ago(120)], .restore),
            ("three within the hour stops auto-restoring",
             [ago(3000), ago(1200), ago(120)], .stopAutoRestoring),
            ("repairs that aged out of the window don't count",
             [ago(7200), ago(5400), ago(3601)], .restore),
            ("the newest timestamp gates the interval, not the oldest",
             [ago(3000), ago(10)], .holdOff),
        ]

        for (name, restores, expected) in cases {
            XCTAssertEqual(HookRestorePolicy.decide(now: now, restores: restores), expected, name)
        }
    }

    /// Only the newest three timestamps can change either answer, so history stays bounded.
    func testRecordKeepsOnlyTheDecisiveTimestamps() {
        var restores: [Date] = []
        for offset in stride(from: 600, through: 0, by: -100) {
            restores = HookRestorePolicy.record(ago(TimeInterval(offset)), in: restores)
        }
        XCTAssertEqual(restores, [ago(200), ago(100), ago(0)])
    }

    /// A tool rewriting the file every few seconds gets exactly three repairs.
    func testSustainedRewritesStopAfterThreeRepairs() {
        var restores: [Date] = []
        var repairs = 0
        for tick in stride(from: 0, through: 3600, by: 5) {
            let time = ago(3600 - TimeInterval(tick))
            switch HookRestorePolicy.decide(now: time, restores: restores) {
            case .restore:
                repairs += 1
                restores = HookRestorePolicy.record(time, in: restores)
            case .holdOff:
                continue
            case .stopAutoRestoring:
                XCTAssertEqual(repairs, 3)
                return
            }
        }
        XCTFail("auto-restore never paused")
    }
}
