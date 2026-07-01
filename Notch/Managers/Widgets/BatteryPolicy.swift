import Foundation

/// A single battery/power read, captured as a plain value so the activity
/// decisions run away from IOKit. `BatteryManager` fills this from
/// `IOPSCopyPowerSourcesInfo` + `ProcessInfo`; the policy sees only the fields it
/// actually decides on (not, e.g., `timeToEmpty`, which is UI-only).
struct BatterySnapshot: Equatable {
    var percent: Int
    var isCharging: Bool
    var isPluggedIn: Bool
    var isFullyCharged: Bool
    var lowPowerMode: Bool
}

/// Turns successive battery snapshots into the activities the notch should
/// publish. Pure: the plug-in edge, the low-battery hysteresis (alerts at <=20%,
/// re-arms only above 25%), the Low Power Mode edge, and each activity's TTL are
/// all decided here from `(snapshot, previous)` — so the transitions are
/// table-testable without a real battery, charger, or Low Power Mode toggle.
enum BatteryPolicy {

    /// The slice of prior state the edge/hysteresis decisions read.
    struct State: Equatable {
        var lastPluggedIn = false
        /// True while a low-battery alert has already fired and hasn't re-armed.
        var lowBatteryNotified = false
        var lowPowerMode = false
    }

    struct Output: Equatable {
        var activities: [Activity]
        var state: State
    }

    static func decide(_ snapshot: BatterySnapshot, previous: State, now: Date) -> Output {
        var state = previous
        var activities: [Activity] = []

        // Surface the power state once when newly plugged in, not on every read.
        if snapshot.isPluggedIn != state.lastPluggedIn {
            state.lastPluggedIn = snapshot.isPluggedIn
            if snapshot.isPluggedIn {
                activities.append(Activity(
                    kind: .charging(percent: snapshot.percent, isCharging: snapshot.isCharging, isFull: snapshot.isFullyCharged),
                    priority: .high, createdAt: now, ttl: 4
                ))
            }
        }

        // Hysteresis: alert once at <=20% on battery, re-arm only above 25% (or
        // once charging) so a percentage hovering at the threshold can't flap.
        if snapshot.percent <= 20 && !snapshot.isCharging && !state.lowBatteryNotified {
            state.lowBatteryNotified = true
            activities.append(Activity(
                kind: .lowBattery(percent: snapshot.percent),
                priority: .urgent, createdAt: now, ttl: 6
            ))
        } else if snapshot.percent > 25 || snapshot.isCharging {
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
