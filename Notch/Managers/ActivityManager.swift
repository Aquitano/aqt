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
        replaceOrInsert(activity)
        cycleOffset = 0
        lastEventID = activity.id
        scheduleTTL(activity)
        state.showCompact()
    }

    func remove(id: UUID) {
        ttlTasks[id]?.cancel()
        ttlTasks[id] = nil
        activities.removeAll { $0.id == id }
        if cycleOffset >= max(activities.count, 1) { cycleOffset = 0 }
    }

    func cycle() {
        guard !activities.isEmpty else { return }
        cycleOffset = (cycleOffset + 1) % activities.count
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
    private func replaceOrInsert(_ activity: Activity) {
        if let key = channelKey(activity.kind) {
            activities.removeAll { channelKey($0.kind) == key }
        }
        activities.append(activity)
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
