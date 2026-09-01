import Observation

/// Runs `handler` with the value of `read` and again whenever any observable
/// property `read` touched changes. Changes are coalesced per main-actor turn,
/// so a burst of mutations produces one call with the final value. Cancel the
/// returned task to stop observing.
@MainActor
@discardableResult
func watch<Value: Sendable>(
    initial: Bool = true,
    _ read: @escaping @MainActor () -> Value,
    onChange handler: @escaping @MainActor (Value) -> Void
) -> Task<Void, Never> {
    let values = Observations { MainActor.assumeIsolated(read) }
    return Task { @MainActor in
        var isFirst = true
        for await value in values {
            defer { isFirst = false }
            if isFirst && !initial { continue }
            handler(value)
        }
    }
}
