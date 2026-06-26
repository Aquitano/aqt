import Foundation
import IOKit.ps
import Combine

/// Battery + power state from IOKit, updated by a run-loop source (no polling).
/// Emits charging / low-battery / low-power activities on state transitions.
@MainActor
final class BatteryManager: ObservableObject {

    @Published private(set) var percent: Int = 100
    @Published private(set) var isCharging = false
    @Published private(set) var isPluggedIn = false
    @Published private(set) var isFullyCharged = false
    @Published private(set) var timeToEmpty: Int?     // minutes, nil if calculating
    @Published private(set) var lowPowerMode = false

    private unowned let activities: ActivityManager
    private var runLoopSource: CFRunLoopSource?
    private var notifiedLowBattery = false
    private var lastPluggedIn = false

    init(activities: ActivityManager) {
        self.activities = activities
    }

    func start() {
        let context = Unmanaged.passUnretained(self).toOpaque()
        let callback: IOPowerSourceCallbackType = { context in
            guard let context else { return }
            let manager = Unmanaged<BatteryManager>.fromOpaque(context).takeUnretainedValue()
            DispatchQueue.main.async { manager.refresh() }
        }
        if let source = IOPSNotificationCreateRunLoopSource(callback, context)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
            runLoopSource = source
        }

        lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            self?.powerStateChanged()
        }

        lastPluggedIn = isPluggedIn
        refresh()
    }

    private func refresh() {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] else { return }

        for source in list {
            guard let description = IOPSGetPowerSourceDescription(blob, source)?.takeUnretainedValue() as? [String: Any]
            else { continue }

            let current = description[kIOPSCurrentCapacityKey] as? Int ?? 0
            let maximum = description[kIOPSMaxCapacityKey] as? Int ?? 100
            let charging = description[kIOPSIsChargingKey] as? Bool ?? false
            let state = description[kIOPSPowerSourceStateKey] as? String
            let plugged = state == kIOPSACPowerValue
            let raw = description[kIOPSTimeToEmptyKey] as? Int ?? -1

            percent = maximum > 0 ? Int((Double(current) / Double(maximum) * 100).rounded()) : current
            isCharging = charging
            isPluggedIn = plugged
            isFullyCharged = plugged && !charging && percent >= 100
            timeToEmpty = raw > 0 ? raw : nil

            evaluateActivities()
            break   // internal battery is the first source
        }
    }

    private func powerStateChanged() {
        let enabled = ProcessInfo.processInfo.isLowPowerModeEnabled
        guard enabled != lowPowerMode else { return }
        lowPowerMode = enabled
        activities.publish(Activity(kind: .lowPowerMode(on: enabled), priority: .high, createdAt: Date(), ttl: 3))
    }

    private func evaluateActivities() {
        if isPluggedIn != lastPluggedIn {
            lastPluggedIn = isPluggedIn
            if isPluggedIn {
                activities.publish(Activity(
                    kind: .charging(percent: percent, isCharging: isCharging, isFull: isFullyCharged),
                    priority: .high, createdAt: Date(), ttl: 4
                ))
            }
        }

        if percent <= 20 && !isCharging && !notifiedLowBattery {
            notifiedLowBattery = true
            activities.publish(Activity(kind: .lowBattery(percent: percent), priority: .urgent, createdAt: Date(), ttl: 6))
        } else if percent > 25 || isCharging {
            notifiedLowBattery = false
        }
    }
}
