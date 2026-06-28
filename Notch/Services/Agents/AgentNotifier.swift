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

    func notify(_ event: AgentEvent) {
        let agent = event.session.kind.shortName
        switch event.kind {
        case .started:
            guard settings.agentNotifyStarted else { return }
            emit(event, suffix: "started", sound: settings.agentSoundStarted,
                 title: "\(agent) started", message: event.session.project,
                 symbol: event.session.kind.symbol, tint: .neutral)
        case .needsAttention:
            guard settings.agentNotifyAttention else { return }
            emit(event, suffix: "attention", sound: settings.agentSoundAttention,
                 title: "\(agent) needs you", message: event.message ?? event.session.project,
                 symbol: "exclamationmark.bubble.fill", tint: .warning)
            if settings.agentAutoExpandOnAttention {
                activities.requestAutoExpand()
            }
        case .finished:
            guard settings.agentNotifyFinished else { return }
            emit(event, suffix: "finished", sound: settings.agentSoundFinished,
                 title: "\(agent) finished", message: event.session.project,
                 symbol: "checkmark.circle.fill", tint: .success)
        case .statusChanged, .ended:
            break
        }
    }

    /// macOS system sounds available for the per-event sound pack.
    static let availableSounds = [
        "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
        "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
    ]

    /// Play a named system sound for preview (Settings).
    static func preview(_ name: String) {
        guard !name.isEmpty else { return }
        NSSound(named: name)?.play()
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

        if settings.agentNotifySound, !sound.isEmpty { NSSound(named: sound)?.play() }
        if settings.agentSystemNotifications { postSystemNotification(title: title, body: message) }
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
