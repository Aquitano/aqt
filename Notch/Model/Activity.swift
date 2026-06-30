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
        case timer(name: String, endsAt: Date)
        case agent(count: Int, kind: AgentKind, project: String, status: AgentStatus)
    }

    enum PeekTint: Equatable {
        case neutral, accent, warning, success
    }

    var isAgent: Bool {
        if case .agent = kind { return true }
        return false
    }

    /// SF Symbol shown in the compact pill for this activity.
    var compactSymbol: String {
        switch kind {
        case .nowPlaying: return "music.note"
        case .charging: return "bolt.fill"
        case .lowBattery: return "battery.25"
        case .lowPowerMode: return "battery.0"
        case let .deviceConnected(_, symbol, _): return symbol
        case let .audioRoute(_, symbol): return symbol
        case let .focus(_, isOn): return isOn ? "moon.fill" : "moon"
        case let .peek(_, _, symbol, _): return symbol
        case .timer: return "timer"
        case let .agent(_, kind, _, _): return kind.symbol
        }
    }

    /// Trailing text in the compact pill. Empty for now-playing (the equalizer
    /// renders there instead). The pill reserves its width from this string, so
    /// the view and the layout must read the same value.
    var compactLabel: String {
        switch kind {
        case .nowPlaying: return ""
        case let .charging(percent, _, _): return "\(percent)%"
        case let .lowBattery(percent): return "\(percent)%"
        case .lowPowerMode: return "Low Power"
        case let .deviceConnected(name, _, battery): return battery.map { "\($0)%" } ?? name
        case let .audioRoute(name, _): return name
        case let .focus(name, _): return name ?? "Focus"
        case let .peek(title, _, _, _): return title
        // The pill draws the live countdown (see CompactView), not the name, so
        // reserve width for the clock — that string is what actually gets rendered.
        case let .timer(_, endsAt): return max(0, endsAt.timeIntervalSinceNow).clockString
        // Terse in the pill (it hugs the notch); the pixel glyph shows activity,
        // the expanded card carries detail. Show the count when more than one runs.
        case let .agent(count, _, _, status): return count > 1 ? "\(count) agents" : status.label
        }
    }
}
