import Foundation

/// A single battery/power read, captured as a plain value so the activity
/// decisions run away from IOKit. `BatteryManager` fills this from
/// `IOPSCopyPowerSourcesInfo` + `ProcessInfo`; the policy sees only the fields it
/// actually decides on (not, e.g., `timeToEmpty`, which is UI-only).
package struct BatterySnapshot: Equatable {
    package var percent: Int
    package var isCharging: Bool
    package var isPluggedIn: Bool
    package var isFullyCharged: Bool
    package var lowPowerMode: Bool

    package init(percent: Int, isCharging: Bool, isPluggedIn: Bool, isFullyCharged: Bool, lowPowerMode: Bool) {
        self.percent = percent
        self.isCharging = isCharging
        self.isPluggedIn = isPluggedIn
        self.isFullyCharged = isFullyCharged
        self.lowPowerMode = lowPowerMode
    }
}

/// Turns successive battery snapshots into the activities the notch should
/// publish. Pure: the plug-in edge, the low-battery hysteresis (alerts at the
/// configured threshold, re-arms only 5 points above it), the Low Power Mode
/// edge, and each activity's TTL are all decided here from
/// `(snapshot, previous)` — so the transitions are table-testable without a
/// real battery, charger, or Low Power Mode toggle.
package enum BatteryPolicy {
    package struct Config: Equatable {
        package var alertThreshold = 20

        package init(alertThreshold: Int = 20) {
            self.alertThreshold = alertThreshold
        }

        /// Alerts re-arm only above this dead band, so a percentage hovering at
        /// the threshold can't flap.
        package var rearmThreshold: Int {
            min(alertThreshold + 5, 100)
        }

        package static let standard = Config()
    }

    /// The slice of prior state the edge/hysteresis decisions read.
    package struct State: Equatable {
        package var lastPluggedIn = false
        /// True while a low-battery alert has already fired and hasn't re-armed.
        package var lowBatteryNotified = false
        package var lowPowerMode = false

        package init(lastPluggedIn: Bool = false, lowBatteryNotified: Bool = false, lowPowerMode: Bool = false) {
            self.lastPluggedIn = lastPluggedIn
            self.lowBatteryNotified = lowBatteryNotified
            self.lowPowerMode = lowPowerMode
        }
    }

    package struct Output: Equatable {
        package var activities: [Activity]
        package var state: State
    }

    package static func decide(
        _ snapshot: BatterySnapshot,
        previous: State,
        config: Config = .standard,
        now: Date
    ) -> Output {
        var state = previous
        var activities: [Activity] = []

        // Surface the power state once when newly plugged in, not on every read.
        if snapshot.isPluggedIn != state.lastPluggedIn {
            state.lastPluggedIn = snapshot.isPluggedIn
            if snapshot.isPluggedIn {
                activities.append(Activity(
                    kind: .charging(
                        percent: snapshot.percent,
                        isCharging: snapshot.isCharging,
                        isFull: snapshot.isFullyCharged
                    ),
                    priority: .high, createdAt: now, ttl: 4
                ))
            }
        }

        // Hysteresis: alert once at the threshold on battery, re-arm only above
        // the dead band (or once charging).
        if snapshot.percent <= config.alertThreshold && !snapshot.isCharging && !state.lowBatteryNotified {
            state.lowBatteryNotified = true
            activities.append(Activity(
                kind: .lowBattery(percent: snapshot.percent),
                priority: .urgent, createdAt: now, ttl: 6
            ))
        } else if snapshot.percent > config.rearmThreshold || snapshot.isCharging {
            state.lowBatteryNotified = false
        }

        // Announce the Low Power Mode transition, not its steady state.
        if snapshot.lowPowerMode != state.lowPowerMode {
            state.lowPowerMode = snapshot.lowPowerMode
            activities.append(Activity(
                kind: .lowPowerMode(on: snapshot.lowPowerMode),
                priority: .high, createdAt: now, ttl: 3
            ))
        }

        return Output(activities: activities, state: state)
    }
}
