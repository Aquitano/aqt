import Foundation

/// Routes agent events to the in-notch Quick Peek surface, gated by the user's
/// per-event toggles and lightly rate-limited so a burst (or a hook + scan
/// double-fire) can't stack duplicate peeks. System notifications + sound are a
/// later phase; this is the always-on in-notch path.
@MainActor
final class AgentNotifier {

    private unowned let activities: ActivityManager
    private let settings: Settings
    private var lastNotified: [String: Date] = [:]

    init(activities: ActivityManager, settings: Settings) {
        self.activities = activities
        self.settings = settings
    }

    func notify(_ event: AgentEvent) {
        let agent = event.session.kind.shortName
        switch event.kind {
        case .started:
            guard settings.agentNotifyStarted else { return }
            emit(event, suffix: "started",
                 title: "\(agent) started", message: event.session.project,
                 symbol: event.session.kind.symbol, tint: .neutral)
        case .needsAttention:
            guard settings.agentNotifyAttention else { return }
            emit(event, suffix: "attention",
                 title: "\(agent) needs you", message: event.message ?? event.session.project,
                 symbol: "exclamationmark.bubble.fill", tint: .warning)
            if settings.agentAutoExpandOnAttention {
                activities.requestAutoExpand()
            }
        case .finished:
            guard settings.agentNotifyFinished else { return }
            emit(event, suffix: "finished",
                 title: "\(agent) finished", message: event.session.project,
                 symbol: "checkmark.circle.fill", tint: .success)
        case .statusChanged, .ended:
            break
        }
    }

    private func emit(_ event: AgentEvent, suffix: String, title: String, message: String,
                      symbol: String, tint: Activity.PeekTint) {
        let key = "\(event.session.id).\(suffix)"
        let now = Date()
        // Drop stale keys so the map can't grow with every session ever seen.
        lastNotified = lastNotified.filter { now.timeIntervalSince($0.value) < 60 }
        if let last = lastNotified[key], now.timeIntervalSince(last) < 3 { return }
        lastNotified[key] = now
        activities.peek(title: title, message: message, symbol: symbol, tint: tint, ttl: 5)
    }
}
