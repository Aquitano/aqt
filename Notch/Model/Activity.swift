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
    }

    enum PeekTint: Equatable {
        case neutral, accent, warning, success
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
        }
    }
}
