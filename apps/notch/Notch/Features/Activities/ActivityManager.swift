import NotchCore
import SwiftUI

/// Ordered priority queue of live activities. The top entry renders in the
/// compact pill; the rest cycle (swipe-down / middle-click). TTLs are one-shot
/// `Task.sleep`s — never repeating timers. Knows nothing about any feature:
/// producers publish `Activity` values and address them by id or channel.
@MainActor
@Observable
final class ActivityManager {
    private(set) var activities: [Activity] = []
    /// Bumps on every new activity so views can fire a one-shot "pop".
    private(set) var lastEventID = UUID()

    private var cycleOffset = 0
    @ObservationIgnored private unowned let notch: NotchCoordinator
    @ObservationIgnored private let clock: any Clock<Duration>
    @ObservationIgnored private var ttlTasks: [UUID: Task<Void, Never>] = [:]

    init(notch: NotchCoordinator, clock: any Clock<Duration> = ContinuousClock()) {
        self.notch = notch
        self.clock = clock
    }

    /// Highest priority first; newest breaks ties.
    var ordered: [Activity] {
        activities.sorted {
            $0.priority != $1.priority ? $0.priority > $1.priority : $0.createdAt > $1.createdAt
        }
    }

    private var pillCandidates: [Activity] {
        ordered.filter(\.showsInPill)
    }

    var compactActivity: Activity? {
        let list = pillCandidates
        guard !list.isEmpty else { return nil }
        return list[cycleOffset % list.count]
    }

    var compactActivityCount: Int {
        pillCandidates.count
    }

    func contains(channel: Activity.Channel) -> Bool {
        activities.contains { $0.channel == channel }
    }

    // MARK: - Mutation

    func publish(_ activity: Activity) {
        // Resetting the cycle and firing the attention pop only on a genuinely new
        // entry keeps an in-place channel update (e.g. an agent's running -> editing,
        // or a charging-percent tick) from yanking the pill back to the top or
        // replaying the pop on every status flip.
        let replaced = replaceOrInsert(activity)
        if !replaced {
            cycleOffset = 0
            lastEventID = activity.id
        }
        scheduleTTL(activity)
        notch.showCompact()
    }

    /// Push a generic Quick Peek from any internal source. Peeks have no channel,
    /// so they stack rather than replace, and always auto-expire.
    func peek(
        title: String,
        message: String = "",
        symbol: String,
        tint: Activity.PeekTint = .neutral,
        ttl: TimeInterval = 4
    ) {
        publish(Activity(
            kind: .peek(title: title, message: message, symbol: symbol, tint: tint),
            priority: .urgent,
            createdAt: Date(),
            ttl: ttl
        ))
    }

    func remove(id: UUID) {
        ttlTasks[id]?.cancel()
        ttlTasks[id] = nil
        activities.removeAll { $0.id == id }
        if cycleOffset >= max(activities.count, 1) {
            cycleOffset = 0
        }
    }

    func remove(channel: Activity.Channel) {
        activities.filter { $0.channel == channel }.forEach { remove(id: $0.id) }
    }

    /// Rotate which queued activity the compact pill shows.
    func cycle(forward: Bool = true) {
        let count = pillCandidates.count
        guard count > 1 else { return }
        cycleOffset = ((cycleOffset + (forward ? 1 : -1)) % count + count) % count
    }

    /// Open the panel on a tab on a producer's behalf (for example when an agent
    /// needs attention and the user opted into auto-expand). The tab is set
    /// before the expand: flipping the presentation first mounts the expanded
    /// body inside that transaction, and a body first evaluated there does not
    /// pick up a tab written later in the same turn.
    func requestExpand(tab: NotchState.ExpandedTab) {
        notch.select(tab: tab)
        notch.expand()
    }

    // MARK: - Helpers

    /// Returns true when it replaced an existing entry on the same channel (vs.
    /// inserting a brand-new activity).
    @discardableResult
    private func replaceOrInsert(_ activity: Activity) -> Bool {
        var replaced = false
        if let channel = activity.channel {
            let before = activities.count
            activities.removeAll { $0.channel == channel }
            replaced = activities.count != before
        }
        activities.append(activity)
        return replaced
    }

    private func scheduleTTL(_ activity: Activity) {
        guard let ttl = activity.ttl else { return }
        ttlTasks[activity.id]?.cancel()
        ttlTasks[activity.id] = Task { [weak self, clock] in
            try? await clock.sleep(for: .seconds(ttl))
            guard !Task.isCancelled else { return }
            self?.remove(id: activity.id)
        }
    }
}
