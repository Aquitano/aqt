import AppKit
import Intents
import NotchCore

/// Focus on/off via INFocusStatusCenter. v1 shows the badge only; the *named*
/// Focus needs Full Disk Access (deferred). Re-reads when the app activates or a
/// view requests it (no public change notification for Focus).
@MainActor
@Observable
final class FocusManager {
    private(set) var isOn = false
    private(set) var name: String?
    private(set) var authorized = false

    private unowned let activities: ActivityManager
    private var activationTask: Task<Void, Never>?
    /// The first read seeds `isOn` from the current Focus; suppress its transition
    /// so launching during an active Focus doesn't publish a spurious "On" toast.
    private var didInitialRead = false

    init(activities: ActivityManager) {
        self.activities = activities
    }

    func start() {
        // Read the current grant without prompting. Prompting here stacks a dialog
        // on top of the location prompt and reads as a freeze; the tile's Enable
        // affordance requests access on demand (mirrors CalendarManager).
        refresh()

        activationTask = Task { @MainActor [weak self] in
            for await _ in NotificationCenter.default.notifications(named: NSApplication.didBecomeActiveNotification) {
                self?.refresh()
            }
        }
    }

    /// Surface the Focus prompt on demand (the tile's "Enable" button), or open the
    /// Notifications pane once the user has denied (macOS won't prompt again).
    func requestAccess() {
        NSApp.activate(ignoringOtherApps: true)
        switch INFocusStatusCenter.default.authorizationStatus {
        case .notDetermined:
            INFocusStatusCenter.default.requestAuthorization { [weak self] status in
                Task { @MainActor in
                    self?.authorized = status == .authorized
                    self?.refresh()
                }
            }
        case .denied, .restricted:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") {
                NSWorkspace.shared.open(url)
            }
        default:
            refresh()
        }
    }

    func refresh() {
        authorized = INFocusStatusCenter.default.authorizationStatus == .authorized
        // Reading focusStatus without authorization spins up a DND XPC connection
        // that immediately fails ("Communication Notifications entitlement"), so
        // skip the query entirely until the user has granted Focus access.
        guard authorized else { return }
        let focused = INFocusStatusCenter.default.focusStatus.isFocused ?? false
        defer { didInitialRead = true }
        guard focused != isOn else { return }
        isOn = focused
        // Don't announce the state we already found at launch as a transition.
        guard didInitialRead else { return }
        activities.publish(Activity(
            kind: .focus(name: name, isOn: focused),
            priority: .low,
            createdAt: Date(),
            ttl: 3
        ))
    }
}
