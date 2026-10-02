import Foundation

/// The pending events, kept in step with their file: the queue is always the
/// file's last `events.count` lines. An enqueue appends; only an acknowledged
/// batch, or enough events dropped by the cap, rewrites the file.
package struct OutboxQueue {
    package private(set) var events: [WireEvent]

    private let file: OutboxFile?
    private let capacity: Int
    private var staleLines = 0
    /// The first write after launch rewrites, which migrates a legacy file and
    /// clears skipped or torn lines before anything is appended after them.
    private var needsRewrite = true

    /// Without a file the queue lives in memory only.
    package init(file: OutboxFile?, events: [WireEvent], capacity: Int) {
        self.file = file
        self.events = Array(events.suffix(capacity))
        self.capacity = capacity
    }

    /// A failed append may have left half a line behind, so it falls back to
    /// a rewrite instead of appending after it next time.
    package mutating func append(_ new: [WireEvent]) -> Result<Void, any Error> {
        events.append(contentsOf: new)
        if !needsRewrite, staleLines <= capacity / 10, let file, case .success = file.append(new) {
            return .success(())
        }
        return rewrite()
    }

    package mutating func removeFirst(_ count: Int) -> Result<Void, any Error> {
        events.removeFirst(count)
        return rewrite()
    }

    /// The file keeps the dropped lines until a tenth of the capacity has piled
    /// up, so a full queue is not rewritten for every event; a restart restores
    /// only the newest `capacity` anyway.
    package mutating func dropOverflow() -> Int {
        let overflow = max(0, events.count - capacity)
        events.removeFirst(overflow)
        staleLines += overflow
        return overflow
    }

    private mutating func rewrite() -> Result<Void, any Error> {
        guard let file else { return .success(()) }
        let saved = file.save(events)
        needsRewrite = true
        if case .success = saved {
            needsRewrite = false
            staleLines = 0
        }
        return saved
    }
}
