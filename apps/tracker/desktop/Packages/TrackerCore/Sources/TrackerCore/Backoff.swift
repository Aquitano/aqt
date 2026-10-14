import Foundation

/// Retry schedule shared with the extension: doubling from a second, capped at
/// five minutes.
package enum Backoff {
    package static let maximumSeconds: TimeInterval = 5 * 60

    package static func seconds(failedAttempts: Int) -> TimeInterval {
        guard failedAttempts > 0 else { return 0 }
        let doubled = exp2(Double(min(failedAttempts, 16)))
        return min(doubled, maximumSeconds)
    }
}

package enum HTTPFailure {
    /// Only a request that will never succeed as written may drop its batch.
    /// 401 and 403 are fixed by signing in, 408 and 429 by waiting. tracker
    /// answers 404 and 405 to no batch: they mean the server URL points
    /// somewhere else, and fixing it delivers the queue.
    package static func isPermanent(status: Int) -> Bool {
        let retryable: Set = [401, 403, 404, 405, 408, 429]
        return (400 ..< 500).contains(status) && !retryable.contains(status)
    }
}
