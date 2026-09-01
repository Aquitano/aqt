import Foundation

/// Throttles automatic repairs of our agent hooks. Pure, so the rules can be
/// table-tested: the caller supplies the current time and the restores it has
/// already performed.
///
/// Two rules, both about not fighting another tool: one repair per minute (an
/// editor or a sync run rewrites a settings file several times in a row), and a
/// hard stop after three repairs in an hour — at that point the other tool owns
/// the file and the user has to settle it.
package struct HookRestorePolicy {

    package enum Decision: Equatable {
        case restore
        /// Too soon after the last repair. The next change event re-checks.
        case holdOff
        /// Repeatedly overwritten: stop repairing and say so once.
        case stopAutoRestoring
    }

    package static let minimumInterval: TimeInterval = 60
    package static let burstWindow: TimeInterval = 3600
    package static let burstLimit = 3

    package static func decide(now: Date, restores: [Date]) -> Decision {
        if restores.filter({ now.timeIntervalSince($0) < burstWindow }).count >= burstLimit {
            return .stopAutoRestoring
        }
        if let last = restores.max(), now.timeIntervalSince(last) < minimumInterval {
            return .holdOff
        }
        return .restore
    }

    /// Only the newest `burstLimit` timestamps can affect either rule, so the
    /// history stays bounded however long the app runs.
    package static func record(_ now: Date, in restores: [Date]) -> [Date] {
        Array((restores + [now]).suffix(burstLimit))
    }
}
