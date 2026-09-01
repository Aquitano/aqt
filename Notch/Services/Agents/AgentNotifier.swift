import AppKit
import Foundation
import UserNotifications

/// Routes agent events to the in-notch Quick Peek surface and, when the user
/// opts in, to Notification Center + a sound. Gated by per-event toggles and
/// lightly rate-limited so a burst (or a hook + scan double-fire) can't stack
/// duplicates.
@MainActor
final class AgentNotifier {

    private unowned let activities: ActivityManager
    private let settings: Settings
    private var lastNotified: [String: Date] = [:]
    private var requestedAuthorization = false

    init(activities: ActivityManager, settings: Settings) {
        self.activities = activities
        self.settings = settings
    }

    /// A peek, a sound and a banner all exist to tell you about a window you
    /// can't see. When the session's own terminal is the thing in front of you,
    /// they're noise — so check that first, and deliver only if it isn't.
    func notify(_ event: AgentEvent) {
        guard settings.agents.quietWhenFocused,
              let bundleID = event.session.terminalBundleID,
              NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID
        else { return deliver(event) }

        // A multiplexer client draws one pane at a time, so its app being in
        // front only counts when this session is the pane on screen. Asking
        // costs a process spawn, hence only on this path — a real notification
        // for a session whose terminal is already frontmost.
        guard let pane = event.session.herdrPaneID else { return }
        Task { @MainActor [weak self] in
            let focused = await Task.detached { HerdrBridge.focusedPaneID() }.value
            guard focused != pane else { return }
            self?.deliver(event)
        }
    }

    private func deliver(_ event: AgentEvent) {
        let agent = event.session.kind.shortName
        switch event.kind {
        case .started:
            guard settings.agents.notifyStarted else { return }
            emit(event, suffix: "started", sound: settings.agents.soundStarted,
                 title: "\(agent) started", message: event.session.project,
                 symbol: event.session.kind.symbol, tint: .neutral)
        case .needsAttention:
            guard settings.agents.notifyAttention else { return }
            emit(event, suffix: "attention", sound: settings.agents.soundAttention,
                 title: "\(agent) needs you", message: event.message ?? event.session.project,
                 symbol: "exclamationmark.bubble.fill", tint: .warning)
            if settings.agents.autoExpandOnAttention {
                activities.requestExpand(tab: .agents)
            }
        case .finished:
            guard settings.agents.notifyFinished else { return }
            emit(event, suffix: "finished", sound: settings.agents.soundFinished,
                 title: "\(agent) finished", message: event.session.project,
                 symbol: "checkmark.circle.fill", tint: .success)
        case .ended:
            break
        }
    }

    /// A notice about the integration itself rather than a session (e.g. the
    /// hook guard repairing a config another tool overwrote). Not gated by the
    /// per-event toggles — those are about agent activity — and never rate
    /// limited here, because its callers already are.
    func notice(title: String, message: String) {
        activities.peek(title: title, message: message, symbol: "wrench.and.screwdriver.fill",
                        tint: .warning, ttl: 6)
        if settings.agents.systemNotifications { postSystemNotification(title: title, body: message) }
    }

    /// Cohesive synthesized sound pack; names are persisted in Settings.
    static let availableSounds = AgentSound.availableNames

    /// Play a synthesized cue for preview in Settings.
    static func preview(_ name: String) {
        AgentSoundPlayer.play(name)
    }

    private func emit(_ event: AgentEvent, suffix: String, sound: String,
                      title: String, message: String, symbol: String, tint: Activity.PeekTint) {
        let key = "\(event.session.id).\(suffix)"
        let now = Date()
        // Drop stale keys so the map can't grow with every session ever seen.
        lastNotified = lastNotified.filter { now.timeIntervalSince($0.value) < 60 }
        if let last = lastNotified[key], now.timeIntervalSince(last) < 3 { return }
        lastNotified[key] = now

        activities.peek(title: title, message: message, symbol: symbol, tint: tint, ttl: 5)

        if settings.agents.soundEnabled { AgentSoundPlayer.play(sound) }
        if settings.agents.systemNotifications { postSystemNotification(title: title, body: message) }
    }

    // MARK: - Notification Center

    private func postSystemNotification(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        ensureAuthorization(center)
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(request)
    }

    private func ensureAuthorization(_ center: UNUserNotificationCenter) {
        guard !requestedAuthorization else { return }
        requestedAuthorization = true
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
}
