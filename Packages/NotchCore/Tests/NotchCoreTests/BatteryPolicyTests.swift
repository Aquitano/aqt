import XCTest
@testable import NotchCore

/// `BatteryPolicy.decide` is a pure function of `(snapshot, previous)`, so the
/// plug-in edge, the low-battery hysteresis, the Low Power Mode edge, and each
/// activity's TTL are table-tested here without a real battery or charger.
final class BatteryPolicyTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func snapshot(
        percent: Int = 80,
        isCharging: Bool = false,
        isPluggedIn: Bool = false,
        isFullyCharged: Bool = false,
        lowPowerMode: Bool = false
    ) -> BatterySnapshot {
        BatterySnapshot(
            percent: percent, isCharging: isCharging, isPluggedIn: isPluggedIn,
            isFullyCharged: isFullyCharged, lowPowerMode: lowPowerMode
        )
    }

    private func decide(_ snap: BatterySnapshot, _ state: BatteryPolicy.State) -> BatteryPolicy.Output {
        BatteryPolicy.decide(snap, previous: state, now: now)
    }

    // MARK: - Plug-in edge

    func testPlugInEmitsChargingOnce() {
        let out = decide(snapshot(percent: 60, isCharging: true, isPluggedIn: true), .init())
        XCTAssertEqual(out.activities.map(\.kind), [.charging(percent: 60, isCharging: true, isFull: false)])
        XCTAssertEqual(out.activities.first?.priority, .high)
        XCTAssertEqual(out.activities.first?.ttl, 4)
        XCTAssertTrue(out.state.lastPluggedIn)
    }

    func testStayingPluggedInEmitsNothing() {
        let out = decide(snapshot(isPluggedIn: true), .init(lastPluggedIn: true))
        XCTAssertTrue(out.activities.isEmpty)
    }

    func testUnplugEmitsNothing() {
        let out = decide(snapshot(isPluggedIn: false), .init(lastPluggedIn: true))
        XCTAssertTrue(out.activities.isEmpty)
        XCTAssertFalse(out.state.lastPluggedIn)
    }

    // MARK: - Low-battery hysteresis

    func testLowBatteryAlertsOnceAtThreshold() {
        let out = decide(snapshot(percent: 20), .init())
        XCTAssertEqual(out.activities.map(\.kind), [.lowBattery(percent: 20)])
        XCTAssertEqual(out.activities.first?.priority, .urgent)
        XCTAssertEqual(out.activities.first?.ttl, 6)
        XCTAssertTrue(out.state.lowBatteryNotified)
    }

    func testLowBatteryDoesNotRepeatWhileArmed() {
        let out = decide(snapshot(percent: 15), .init(lowBatteryNotified: true))
        XCTAssertTrue(out.activities.isEmpty)
        XCTAssertTrue(out.state.lowBatteryNotified)
    }

    func testLowBatteryStaysArmedBetween20And25() {
        // 22% is in the dead band: no new alert, but the alert stays armed so it
        // won't re-fire when the level dips back to 20%.
        let out = decide(snapshot(percent: 22), .init(lowBatteryNotified: true))
        XCTAssertTrue(out.activities.isEmpty)
        XCTAssertTrue(out.state.lowBatteryNotified)
    }

    func testLowBatteryReArmsAbove25() {
        let out = decide(snapshot(percent: 26), .init(lowBatteryNotified: true))
        XCTAssertTrue(out.activities.isEmpty)
        XCTAssertFalse(out.state.lowBatteryNotified)
    }

    func testChargingReArmsAndSuppressesLowBattery() {
        let out = decide(snapshot(percent: 10, isCharging: true), .init(lowBatteryNotified: true))
        XCTAssertTrue(out.activities.isEmpty)
        XCTAssertFalse(out.state.lowBatteryNotified)
    }

    func testReArmedLowBatteryFiresAgainOnNextDip() {
        var state = BatteryPolicy.State(lowBatteryNotified: true)
        state = decide(snapshot(percent: 30), state).state          // re-arm above 25
        let out = decide(snapshot(percent: 18), state)              // dip again
        XCTAssertEqual(out.activities.map(\.kind), [.lowBattery(percent: 18)])
    }

    // MARK: - Configurable threshold

    func testCustomThresholdMovesAlertAndRearmBand() {
        let config = BatteryPolicy.Config(alertThreshold: 30)

        let fired = BatteryPolicy.decide(snapshot(percent: 30), previous: .init(), config: config, now: now)
        XCTAssertEqual(fired.activities.map { $0.kind }, [.lowBattery(percent: 30)])

        // 33% sits in the moved dead band (30...35): armed, no re-fire.
        let held = BatteryPolicy.decide(
            snapshot(percent: 33), previous: .init(lowBatteryNotified: true), config: config, now: now
        )
        XCTAssertTrue(held.activities.isEmpty)
        XCTAssertTrue(held.state.lowBatteryNotified)

        let rearmed = BatteryPolicy.decide(
            snapshot(percent: 36), previous: .init(lowBatteryNotified: true), config: config, now: now
        )
        XCTAssertFalse(rearmed.state.lowBatteryNotified)
    }

    // MARK: - Low Power Mode edge

    func testLowPowerModeOnEmitsTransition() {
        let out = decide(snapshot(lowPowerMode: true), .init())
        XCTAssertEqual(out.activities.map(\.kind), [.lowPowerMode(on: true)])
        XCTAssertEqual(out.activities.first?.priority, .high)
        XCTAssertEqual(out.activities.first?.ttl, 3)
        XCTAssertTrue(out.state.lowPowerMode)
    }

    func testLowPowerModeOffEmitsTransition() {
        let out = decide(snapshot(lowPowerMode: false), .init(lowPowerMode: true))
        XCTAssertEqual(out.activities.map(\.kind), [.lowPowerMode(on: false)])
        XCTAssertFalse(out.state.lowPowerMode)
    }

    func testLowPowerModeSteadyStateEmitsNothing() {
        let out = decide(snapshot(lowPowerMode: true), .init(lowPowerMode: true))
        XCTAssertTrue(out.activities.isEmpty)
    }

    // MARK: - Combined transitions

    func testPlugInWhileLowAndLowPowerEmitsAllThree() {
        // A read that crosses several edges at once still yields one activity each,
        // in a stable order: charging, then low-battery, then low-power.
        let out = decide(
            snapshot(percent: 18, isCharging: false, isPluggedIn: true, lowPowerMode: true),
            .init()
        )
        XCTAssertEqual(out.activities.map(\.kind), [
            .charging(percent: 18, isCharging: false, isFull: false),
            .lowBattery(percent: 18),
            .lowPowerMode(on: true),
        ])
    }
}
