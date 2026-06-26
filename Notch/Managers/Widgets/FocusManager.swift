import Intents
import AppKit
import Combine

/// Focus on/off via INFocusStatusCenter. v1 shows the badge only; the *named*
/// Focus needs Full Disk Access (deferred). Re-reads when the app activates or a
/// view requests it (no public change notification for Focus).
@MainActor
final class FocusManager: ObservableObject {

    @Published private(set) var isOn = false
    @Published private(set) var name: String?
    @Published private(set) var authorized = false

    private unowned let activities: ActivityManager
    private var cancellables = Set<AnyCancellable>()

    init(activities: ActivityManager) {
        self.activities = activities
    }

    func start() {
        INFocusStatusCenter.default.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                self?.authorized = status == .authorized
                self?.refresh()
            }
        }

        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.refresh() }
            .store(in: &cancellables)
    }

    func refresh() {
        // Reading focusStatus without authorization spins up a DND XPC connection
        // that immediately fails ("Communication Notifications entitlement"), so
        // skip the query entirely until the user has granted Focus access.
        guard authorized else { return }
        let focused = INFocusStatusCenter.default.focusStatus.isFocused ?? false
        guard focused != isOn else { return }
        isOn = focused
        activities.publish(Activity(kind: .focus(name: name, isOn: focused),
                                    priority: .low, createdAt: Date(), ttl: 3))
    }
}
