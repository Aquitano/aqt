import Foundation

package struct FocusTarget: Sendable, Equatable {
    package var bundleID: String
    package var appName: String

    /// Localized names can carry a directionality mark, which no rule
    /// anchored at ^ would ever match.
    package init(bundleID: String, appName: String) {
        self.bundleID = bundleID
        self.appName = appName.trimmingCharacters(in: .controlCharacters)
    }
}

package enum SpanInput: Sendable, Equatable {
    /// The title travels with the app change so a switch does not open a span
    /// with no title and immediately close it again as `window_change`.
    case frontmost(FocusTarget, windowTitle: String?)
    case windowTitle(String?)
    /// `since` is the last input, a full detection interval before idle was
    /// noticed; that is when attention stopped, not when the poll ran.
    case idle(since: Date)
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
    /// Titles reported while an ignored overlay is frontmost are its own, not
    /// those of the app whose span it leaves open underneath.
    private var ignoredInFront = false

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
            return focusChanged(to: target, title: title, at: now)

        case let .windowTitle(title):
            return titleChanged(to: title, at: now)

        case let .idle(since):
            guard !isIdle else { return [] }
            isIdle = true
            return close(.idle, at: since)

        case .active:
            guard isIdle else { return [] }
            isIdle = false
            return open(at: now)

        case .stop:
            return close(.unknown, at: now)
        }
    }

    private mutating func focusChanged(to target: FocusTarget, title: String?, at now: Date) -> [WireEvent] {
        ignoredInFront = configuration.isIgnored(target.bundleID)
        guard !ignoredInFront else { return [] }
        guard target != focus else { return titleChanged(to: title, at: now) }
        focus = target
        windowTitle = title
        return close(.appSwitch, at: now) + open(at: now)
    }

    private mutating func titleChanged(to title: String?, at now: Date) -> [WireEvent] {
        guard !ignoredInFront, let focus, title != windowTitle else { return [] }
        guard !configuration.isPrivate(focus.bundleID) else { return [] }
        windowTitle = title
        guard openSpan != nil else { return [] }
        return close(.windowChange, at: now) + open(at: now)
    }

    package func heartbeat(at now: Date) -> [WireEvent] {
        guard let openSpan else { return [] }
        return [.spanHeartbeat(SpanHeartbeat(id: openSpan.id, at: now))]
    }

    private mutating func close(_ reason: EndReason, at endedAt: Date) -> [WireEvent] {
        guard let openSpan else { return [] }
        self.openSpan = nil
        return [.spanEnd(SpanEnd(id: openSpan.id, endedAt: max(openSpan.startedAt, endedAt), reason: reason))]
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
