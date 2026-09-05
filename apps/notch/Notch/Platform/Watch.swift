import Observation
import NotchCore

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

/// Same as `watch`, but only calls `handler` when the value actually changed.
/// Preferences are tracked per group, so a reader of one flag would otherwise
/// fire on every sibling toggle.
@MainActor
@discardableResult
func watch<Value: Sendable & Equatable>(
    initial: Bool = true,
    _ read: @escaping @MainActor () -> Value,
    onChange handler: @escaping @MainActor (Value) -> Void
) -> Task<Void, Never> {
    let values = Observations { MainActor.assumeIsolated(read) }
    return Task { @MainActor in
        var previous: Value?
        for await value in values {
            defer { previous = value }
            if let previous {
                if previous != value { handler(value) }
            } else if initial {
                handler(value)
            }
        }
    }
}
