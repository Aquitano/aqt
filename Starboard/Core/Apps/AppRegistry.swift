import AppKit

/// Running apps with regular activation policy, plus most-recently-used order.
///
/// TODO(Phase 1): replace polling refresh with KVO on
/// NSWorkspace.runningApplications and didActivateApplicationNotification for
/// MRU tracking (BATTLEPLAN §3.4).
final class AppRegistry {
    private(set) var runningApps: [NSRunningApplication] = []

    init() {
        refresh()
    }

    func refresh() {
        runningApps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
    }
}
