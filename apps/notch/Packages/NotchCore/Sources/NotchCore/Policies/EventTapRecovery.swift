import Foundation

/// Repeated stalls leave the tap disabled until the user restarts it.
package struct EventTapRecovery {
    private var recentDisables: [TimeInterval] = []
    private var lockedOut = false

    package init() {}

    package mutating func shouldReenable(at time: TimeInterval) -> Bool {
        guard !lockedOut else { return false }
        recentDisables.removeAll { time - $0 > 30 }
        recentDisables.append(time)
        lockedOut = recentDisables.count >= 3
        return !lockedOut
    }
}
