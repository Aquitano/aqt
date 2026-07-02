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
    /// False on a desktop Mac (or when only a UPS is attached), so the tile can hide
    /// instead of showing a fake permanent 100%.
    @Published private(set) var hasBattery = true

    private unowned let activities: ActivityManager
    private var runLoopSource: CFRunLoopSource?
    private var policy = BatteryPolicy.State()

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
        policy.lowPowerMode = lowPowerMode
        NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            self?.powerStateChanged()
        }

        refresh()
    }

    private func refresh() {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] else { return }

        // Pick the internal battery by type — not the first source, which could be a
        // UPS — and treat its absence as "no battery" rather than a fake 100%.
        let internalBattery = list.lazy
            .compactMap { IOPSGetPowerSourceDescription(blob, $0)?.takeUnretainedValue() as? [String: Any] }
            .first { ($0[kIOPSTypeKey] as? String) == kIOPSInternalBatteryType }

        guard let description = internalBattery else {
            hasBattery = false
            return
        }
        hasBattery = true

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

        evaluate()
    }

    private func powerStateChanged() {
        let enabled = ProcessInfo.processInfo.isLowPowerModeEnabled
        guard enabled != lowPowerMode else { return }
        lowPowerMode = enabled
        evaluate()
    }

    private func evaluate() {
        let snapshot = BatterySnapshot(
            percent: percent, isCharging: isCharging, isPluggedIn: isPluggedIn,
            isFullyCharged: isFullyCharged, lowPowerMode: lowPowerMode
        )
        let output = BatteryPolicy.decide(snapshot, previous: policy, now: Date())
        policy = output.state
        output.activities.forEach { activities.publish($0) }
    }
}
