import Foundation
@testable import NotchCore
import Testing

/// `BatteryPolicy.decide` is a pure function of `(snapshot, previous)`, so the
/// plug-in edge, the low-battery hysteresis, the Low Power Mode edge, and each
/// activity's TTL are table-tested here without a real battery or charger.
struct BatteryPolicyTests {
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

    @Test func plugInEmitsChargingOnce() {
        let out = decide(snapshot(percent: 60, isCharging: true, isPluggedIn: true), .init())
        #expect(out.activities.map(\.kind) == [.charging(percent: 60, isCharging: true, isFull: false)])
        #expect(out.activities.first?.priority == .high)
        #expect(out.activities.first?.ttl == 4)
        #expect(out.state.lastPluggedIn)
    }

    @Test func stayingPluggedInEmitsNothing() {
        let out = decide(snapshot(isPluggedIn: true), .init(lastPluggedIn: true))
        #expect(out.activities.isEmpty)
    }

    @Test func unplugEmitsNothing() {
        let out = decide(snapshot(isPluggedIn: false), .init(lastPluggedIn: true))
        #expect(out.activities.isEmpty)
        #expect(!out.state.lastPluggedIn)
    }

    // MARK: - Low-battery hysteresis

    @Test func lowBatteryAlertsOnceAtThreshold() {
        let out = decide(snapshot(percent: 20), .init())
        #expect(out.activities.map(\.kind) == [.lowBattery(percent: 20)])
        #expect(out.activities.first?.priority == .urgent)
        #expect(out.activities.first?.ttl == 6)
        #expect(out.state.lowBatteryNotified)
    }

    @Test func lowBatteryDoesNotRepeatWhileArmed() {
        let out = decide(snapshot(percent: 15), .init(lowBatteryNotified: true))
        #expect(out.activities.isEmpty)
        #expect(out.state.lowBatteryNotified)
    }

    @Test func lowBatteryStaysArmedBetween20And25() {
        // 22% is in the dead band: no new alert, but the alert stays armed so it
        // won't re-fire when the level dips back to 20%.
        let out = decide(snapshot(percent: 22), .init(lowBatteryNotified: true))
        #expect(out.activities.isEmpty)
        #expect(out.state.lowBatteryNotified)
    }

    @Test func lowBatteryReArmsAbove25() {
        let out = decide(snapshot(percent: 26), .init(lowBatteryNotified: true))
        #expect(out.activities.isEmpty)
        #expect(!out.state.lowBatteryNotified)
    }

    @Test func chargingReArmsAndSuppressesLowBattery() {
        let out = decide(snapshot(percent: 10, isCharging: true), .init(lowBatteryNotified: true))
        #expect(out.activities.isEmpty)
        #expect(!out.state.lowBatteryNotified)
    }

    @Test func reArmedLowBatteryFiresAgainOnNextDip() {
        var state = BatteryPolicy.State(lowBatteryNotified: true)
        state = decide(snapshot(percent: 30), state).state // re-arm above 25
        let out = decide(snapshot(percent: 18), state) // dip again
        #expect(out.activities.map(\.kind) == [.lowBattery(percent: 18)])
    }

    // MARK: - Configurable threshold

    @Test func customThresholdMovesAlertAndRearmBand() {
        let config = BatteryPolicy.Config(alertThreshold: 30)

        let fired = BatteryPolicy.decide(snapshot(percent: 30), previous: .init(), config: config, now: now)
        #expect(fired.activities.map { $0.kind } == [.lowBattery(percent: 30)])

        // 33% sits in the moved dead band (30...35): armed, no re-fire.
        let held = BatteryPolicy.decide(
            snapshot(percent: 33), previous: .init(lowBatteryNotified: true), config: config, now: now
        )
        #expect(held.activities.isEmpty)
        #expect(held.state.lowBatteryNotified)

        let rearmed = BatteryPolicy.decide(
            snapshot(percent: 36), previous: .init(lowBatteryNotified: true), config: config, now: now
        )
        #expect(!rearmed.state.lowBatteryNotified)
    }

    // MARK: - Low Power Mode edge

    @Test func lowPowerModeOnEmitsTransition() {
        let out = decide(snapshot(lowPowerMode: true), .init())
        #expect(out.activities.map(\.kind) == [.lowPowerMode(on: true)])
        #expect(out.activities.first?.priority == .high)
        #expect(out.activities.first?.ttl == 3)
        #expect(out.state.lowPowerMode)
    }

    @Test func lowPowerModeOffEmitsTransition() {
        let out = decide(snapshot(lowPowerMode: false), .init(lowPowerMode: true))
        #expect(out.activities.map(\.kind) == [.lowPowerMode(on: false)])
        #expect(!out.state.lowPowerMode)
    }

    @Test func lowPowerModeSteadyStateEmitsNothing() {
        let out = decide(snapshot(lowPowerMode: true), .init(lowPowerMode: true))
        #expect(out.activities.isEmpty)
    }

    // MARK: - Combined transitions

    @Test func plugInWhileLowAndLowPowerEmitsAllThree() {
        // A read that crosses several edges at once still yields one activity each,
        // in a stable order: charging, then low-battery, then low-power.
        let out = decide(
            snapshot(percent: 18, isCharging: false, isPluggedIn: true, lowPowerMode: true),
            .init()
        )
        #expect(out.activities.map(\.kind) == [
            .charging(percent: 18, isCharging: false, isFull: false),
            .lowBattery(percent: 18),
            .lowPowerMode(on: true),
        ])
    }
}
