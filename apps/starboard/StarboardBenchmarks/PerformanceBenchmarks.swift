@testable import Starboard
import XCTest

final class PerformanceBenchmarks: XCTestCase {
    func testFuzzyRankingThroughput() {
        let candidates = (0 ..< 500).map { "Application \($0) Project Workspace" }
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(), XCTMemoryMetric()]) {
            for candidate in candidates {
                _ = FuzzyMatcher.score(query: "appwork", target: candidate)
            }
        }
    }

    func testKeyRoutingThroughput() {
        let router = KeyRouter(
            resolveLetter: { Keycode.letters[$0] },
            resolveDigit: { Keycode.digits[$0] }
        )
        let modifiers = ModifierState(rightCommandHeld: true)
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(), XCTMemoryMetric()]) {
            for _ in 0 ..< 10000 {
                _ = router.keyDown(0x01, modifiers: modifiers)
                _ = router.rightCommandUp()
            }
        }
    }
}
