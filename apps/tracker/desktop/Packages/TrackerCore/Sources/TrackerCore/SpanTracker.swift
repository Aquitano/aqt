import Foundation

package struct FocusTarget: Sendable, Equatable {
    package var bundleID: String
    package var appName: String

    package init(bundleID: String, appName: String) {
        self.bundleID = bundleID
        self.appName = appName
    }
}

package enum SpanInput: Sendable, Equatable {
    /// The title travels with the app change so a switch does not open a span
    /// with no title and immediately close it again as `window_change`.
    case frontmost(FocusTarget, windowTitle: String?)
    case windowTitle(String?)
    case idle
    case active
    case stop
}

package struct OpenSpan: Sendable, Equatable {
    package var id: String
    package var target: FocusTarget
    package var windowTitle: String?
    package var startedAt: Date
}

/// The whole span policy, free of AppKit and of the network, so every rule is
/// decided by one pure function. At most one span is open at a time.
package struct SpanTracker: Sendable {
    private let configuration: TrackerConfiguration
    private let newSpanID: @Sendable (Date) -> String
    private var focus: FocusTarget?
    private var windowTitle: String?
    private var isIdle = false

    package private(set) var openSpan: OpenSpan?

    package init(
        configuration: TrackerConfiguration,
        newSpanID: @escaping @Sendable (Date) -> String = { UUIDv7.string(at: $0) }
    ) {
        self.configuration = configuration
        self.newSpanID = newSpanID
    }

    package mutating func apply(_ input: SpanInput, at now: Date) -> [WireEvent] {
        switch input {
        case let .frontmost(target, title):
            guard target != focus else { return apply(.windowTitle(title), at: now) }
            focus = target
            windowTitle = title
            return close(.appSwitch, at: now) + open(at: now)

        case let .windowTitle(title):
            guard let focus, !configuration.isPrivate(focus.bundleID), title != windowTitle else { return [] }
            windowTitle = title
            guard openSpan != nil else { return [] }
            return close(.windowChange, at: now) + open(at: now)

        case .idle:
            guard !isIdle else { return [] }
            isIdle = true
            return close(.idle, at: now)

        case .active:
            guard isIdle else { return [] }
            isIdle = false
            return open(at: now)

        case .stop:
            return close(.unknown, at: now)
        }
    }

    package func heartbeat(at now: Date) -> [WireEvent] {
        guard let openSpan else { return [] }
        return [.spanHeartbeat(SpanHeartbeat(id: openSpan.id, at: now))]
    }

    private mutating func close(_ reason: EndReason, at now: Date) -> [WireEvent] {
        guard let openSpan else { return [] }
        self.openSpan = nil
        return [.spanEnd(SpanEnd(id: openSpan.id, endedAt: now, reason: reason))]
    }

    private mutating func open(at now: Date) -> [WireEvent] {
        guard let focus, !isIdle, !configuration.isSkipped(focus.bundleID) else { return [] }
        let title = configuration.isPrivate(focus.bundleID) ? nil : windowTitle
        let span = OpenSpan(id: newSpanID(now), target: focus, windowTitle: title, startedAt: now)
        openSpan = span
        return [.spanStart(SpanStart(
            id: span.id,
            startedAt: span.startedAt,
            appName: focus.appName,
            bundleID: focus.bundleID,
            windowTitle: title
        ))]
    }
}
