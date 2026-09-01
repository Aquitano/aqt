import Foundation

/// One thing the notch can surface as a live activity / Quick Peek.
/// The manager keeps an ordered queue; the highest-priority entry renders in the
/// compact pill, the rest cycle (swipe-down / middle-click).
struct Activity: Identifiable, Equatable {
    let id: UUID
    var kind: Kind
    var priority: Priority
    var createdAt: Date
    /// nil = sticky until explicitly removed (e.g. now playing while audio plays).
    var ttl: TimeInterval?

    init(id: UUID = UUID(),
         kind: Kind,
         priority: Priority,
         createdAt: Date,
         ttl: TimeInterval? = nil) {
        self.id = id
        self.kind = kind
        self.priority = priority
        self.createdAt = createdAt
        self.ttl = ttl
    }

    enum Priority: Int, Comparable {
        case ambient = 0      // now playing
        case low = 10         // focus badge
        case normal = 20      // device connect, route change
        case high = 30        // charging / power
        case urgent = 40      // low battery, user peeks
        static func < (lhs: Priority, rhs: Priority) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    enum Kind: Equatable {
        case nowPlaying
        case charging(percent: Int, isCharging: Bool, isFull: Bool)
        case lowBattery(percent: Int)
        case lowPowerMode(on: Bool)
        case deviceConnected(name: String, symbol: String, battery: Int?)
        case audioRoute(name: String, symbol: String)
        case focus(name: String?, isOn: Bool)
        case peek(title: String, message: String, symbol: String, tint: PeekTint)
        /// `pausedRemaining` non-nil freezes the countdown at that value.
        case timer(name: String, endsAt: Date, pausedRemaining: TimeInterval?)
        case agent(count: Int, kind: AgentKind, project: String, status: AgentStatus)
        case screenshotCandidates([ScreenshotCandidate])
    }

    enum PeekTint: Equatable {
        case neutral, accent, warning, success
    }

    /// Singleton channels: publishing on an occupied channel replaces the
    /// previous entry in place. Kinds without a channel stack.
    enum Channel: Hashable {
        case nowPlaying, power, lowBattery, lowPowerMode, focus, agents, screenshots
        case device(String)
        case route(String)
    }

    var channel: Channel? {
        switch kind {
        case .nowPlaying: .nowPlaying
        case .charging: .power
        case .lowBattery: .lowBattery
        case .lowPowerMode: .lowPowerMode
        case .focus: .focus
        case let .deviceConnected(name, _, _): .device(name)
        case let .audioRoute(name, _): .route(name)
        case .agent: .agents
        case .screenshotCandidates: .screenshots
        case .peek, .timer: nil
        }
    }

    /// Now Playing owns a dedicated compact presentation (artwork + meter), so
    /// its bookkeeping entry never appears as a generic pill.
    var showsInPill: Bool {
        if case .nowPlaying = kind { return false }
        return true
    }

    /// Active session count when this is the aggregate agent entry, else nil.
    var agentCount: Int? {
        if case let .agent(count, _, _, _) = kind { return count }
        return nil
    }
}
