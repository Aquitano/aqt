import SwiftUI
import Combine

/// Ordered priority queue of live activities. The top entry renders in the
/// compact pill; the rest cycle (swipe-down / middle-click). TTLs are one-shot
/// `Task.sleep`s — never repeating timers.
@MainActor
final class ActivityManager: ObservableObject {

    @Published private(set) var activities: [Activity] = []
    /// Bumps on every new activity so views can fire a one-shot "pop".
    @Published private(set) var lastEventID = UUID()

    private var cycleOffset = 0
    private unowned let state: NotchState
    private var ttlTasks: [UUID: Task<Void, Never>] = [:]

    init(state: NotchState) {
        self.state = state
    }

    /// Highest priority first; newest breaks ties.
    var ordered: [Activity] {
        activities.sorted {
            $0.priority != $1.priority ? $0.priority > $1.priority : $0.createdAt > $1.createdAt
        }
    }

    var compactActivity: Activity? {
        let list = ordered
        guard !list.isEmpty else { return nil }
        return list[cycleOffset % list.count]
    }

    // MARK: - Mutation

    func publish(_ activity: Activity) {
        // Resetting the cycle only on a genuinely new entry keeps an in-place
        // channel update (e.g. an agent's running -> editing) from yanking the
        // pill back to the top while the user is cycling through activities.
        let replaced = replaceOrInsert(activity)
        if !replaced { cycleOffset = 0 }
        lastEventID = activity.id
        scheduleTTL(activity)
        state.showCompact()
    }

    /// Push a generic Quick Peek from any internal source. Peeks have no channel
    /// key, so they stack rather than replace, and always auto-expire.
    func peek(title: String,
              message: String = "",
              symbol: String,
              tint: Activity.PeekTint = .neutral,
              ttl: TimeInterval = 4) {
        publish(Activity(kind: .peek(title: title, message: message, symbol: symbol, tint: tint),
                         priority: .urgent, createdAt: Date(), ttl: ttl))
    }

    /// Mirror an agent session into the pill. Sticky (no TTL); the `AgentManager`
    /// removes the channel when the session leaves a busy / needs-attention state.
    func publishAgent(_ session: AgentSession) {
        let priority: Activity.Priority = session.status == .needsAttention ? .urgent : .normal
        publish(Activity(
            kind: .agent(sessionID: session.id, kind: session.kind, project: session.project, status: session.status),
            priority: priority,
            createdAt: Date()
        ))
    }

    func removeAgent(sessionID: String) {
        let ids = activities.compactMap { activity -> UUID? in
            if case let .agent(id, _, _, _) = activity.kind, id == sessionID { return activity.id }
            return nil
        }
        ids.forEach { remove(id: $0) }
    }

    /// Open the panel on the Agents tab — used when a session needs attention and
    /// the user opted into auto-expand.
    func requestAutoExpand() {
        state.expand()
        state.select(tab: .agents)
    }

    func remove(id: UUID) {
        ttlTasks[id]?.cancel()
        ttlTasks[id] = nil
        activities.removeAll { $0.id == id }
        if cycleOffset >= max(activities.count, 1) { cycleOffset = 0 }
    }

    /// Rotate which queued activity the compact pill shows. `cycleOffset` is not a
    /// `@Published` property, so notify observers explicitly.
    func cycle(forward: Bool = true) {
        let count = activities.count
        guard count > 1 else { return }
        objectWillChange.send()
        cycleOffset = ((cycleOffset + (forward ? 1 : -1)) % count + count) % count
    }

    /// Media owns whether a now-playing activity exists.
    func setNowPlaying(active: Bool) {
        if active {
            if !activities.contains(where: { isNowPlaying($0) }) {
                replaceOrInsert(Activity(kind: .nowPlaying, priority: .ambient, createdAt: Date()))
            }
        } else {
            activities.removeAll { isNowPlaying($0) }
        }
    }

    // MARK: - Helpers

    private func isNowPlaying(_ activity: Activity) -> Bool {
        if case .nowPlaying = activity.kind { return true }
        return false
    }

    /// Singleton channels (charging, focus, ...) replace the previous entry;
    /// everything else is appended.
    /// Returns true when it replaced an existing entry on the same channel (vs.
    /// inserting a brand-new activity).
    @discardableResult
    private func replaceOrInsert(_ activity: Activity) -> Bool {
        var replaced = false
        if let key = channelKey(activity.kind) {
            let before = activities.count
            activities.removeAll { channelKey($0.kind) == key }
            replaced = activities.count != before
        }
        activities.append(activity)
        return replaced
    }

    private func channelKey(_ kind: Activity.Kind) -> String? {
        switch kind {
        case .nowPlaying: return "nowPlaying"
        case .charging: return "power"
        case .lowBattery: return "lowBattery"
        case .lowPowerMode: return "lowPowerMode"
        case .focus: return "focus"
        case let .deviceConnected(name, _, _): return "device.\(name)"
        case let .audioRoute(name, _): return "route.\(name)"
        case let .agent(sessionID, _, _, _): return "agent.\(sessionID)"
        case .peek, .timer: return nil
        }
    }

    private func scheduleTTL(_ activity: Activity) {
        guard let ttl = activity.ttl else { return }
        ttlTasks[activity.id]?.cancel()
        ttlTasks[activity.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ttl))
            guard !Task.isCancelled else { return }
            self?.remove(id: activity.id)
        }
    }
}
