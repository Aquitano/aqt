import Observation

/// Runs `handler` whenever the observable value `read` returns changes.
/// Cancel the returned task to stop observing.
@MainActor
@discardableResult
func watch<Value: Sendable & Equatable>(
    _ read: @escaping @MainActor () -> Value,
    onChange handler: @escaping @MainActor (Value) -> Void
) -> Task<Void, Never> {
    let values = Observations { MainActor.assumeIsolated(read) }
    return Task { @MainActor in
        var previous: Value?
        for await value in values {
            defer { previous = value }
            guard previous != value else { continue }
            handler(value)
        }
    }
}
