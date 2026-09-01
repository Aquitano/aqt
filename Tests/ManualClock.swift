import Foundation

/// A clock that only moves when a test says so. Sleepers wake in deadline
/// order when `advance(by:)` passes them, and the call yields until the woken
/// tasks have had a chance to run.
final class ManualClock: Clock, @unchecked Sendable {
    struct Instant: InstantProtocol {
        var offset: Duration
        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct Sleeper {
        let id: UUID
        let deadline: Instant
        let continuation: CheckedContinuation<Void, any Error>
    }

    private let lock = NSLock()
    private var _now = Instant(offset: .zero)
    private var sleepers: [Sleeper] = []

    var now: Instant { lock.withLock { _now } }
    var minimumResolution: Duration { .zero }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.withLock {
                    if deadline <= _now {
                        continuation.resume()
                    } else {
                        sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    }
                }
            }
        } onCancel: {
            let cancelled = lock.withLock { () -> Sleeper? in
                guard let index = sleepers.firstIndex(where: { $0.id == id }) else { return nil }
                return sleepers.remove(at: index)
            }
            cancelled?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by duration: Duration) async {
        // Tasks created just before the call must reach their sleep first, or
        // they would compute their deadline against the already-advanced clock.
        await Self.settle()
        let target = now.advanced(by: duration)
        while true {
            let next = lock.withLock { () -> Sleeper? in
                guard let due = sleepers.filter({ $0.deadline <= target }).min(by: { $0.deadline < $1.deadline }) else {
                    _now = target
                    return nil
                }
                _now = due.deadline
                sleepers.removeAll { $0.id == due.id }
                return due
            }
            guard let next else { break }
            next.continuation.resume()
            await Self.settle()
        }
        await Self.settle()
    }

    /// Give resumed tasks several turns to run to their next suspension point
    /// before the test inspects state. The main-actor hop drains jobs the woken
    /// tasks enqueued there, in order, which a bare yield on this executor
    /// would race past.
    private static func settle() async {
        for _ in 0..<10 {
            await Task.yield()
            await MainActor.run {}
        }
    }
}
