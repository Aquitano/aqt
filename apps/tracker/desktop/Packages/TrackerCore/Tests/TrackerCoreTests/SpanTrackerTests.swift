import Foundation
import Testing
@testable import TrackerCore

private let editor = FocusTarget(bundleID: "com.microsoft.VSCode", appName: "Code")
private let terminal = FocusTarget(bundleID: "com.apple.Terminal", appName: "Terminal")
private let chrome = FocusTarget(bundleID: "com.google.Chrome", appName: "Google Chrome")
private let vault = FocusTarget(bundleID: "com.1password.1password", appName: "1Password")
private let dock = FocusTarget(bundleID: "com.apple.dock", appName: "Dock")

private func makeTracker() -> SpanTracker {
    let counter = Counter()
    return SpanTracker(configuration: TrackerConfiguration()) { _ in counter.next() }
}

private final class Counter: @unchecked Sendable {
    private var value = 0
    func next() -> String {
        value += 1
        return "span-\(value)"
    }
}

private func start(_ event: WireEvent) -> SpanStart? {
    if case let .spanStart(start) = event {
        return start
    }
    return nil
}

private func end(_ event: WireEvent) -> SpanEnd? {
    if case let .spanEnd(end) = event {
        return end
    }
    return nil
}

struct SpanTrackerTests {
    @Test func appSwitchClosesTheOldSpanAndOpensANewOne() {
        var tracker = makeTracker()
        _ = tracker.apply(.frontmost(editor, windowTitle: "main.go"), at: .now)

        let events = tracker.apply(.frontmost(terminal, windowTitle: "zsh"), at: .now)

        #expect(events.count == 2)
        #expect(end(events[0])?.id == "span-1")
        #expect(end(events[0])?.reason == .appSwitch)
        #expect(start(events[1])?.bundleID == terminal.bundleID)
        #expect(start(events[1])?.windowTitle == "zsh")
    }

    @Test func titleChangeReopensTheSpanWithTheNewTitle() {
        var tracker = makeTracker()
        _ = tracker.apply(.frontmost(editor, windowTitle: "main.go"), at: .now)

        let events = tracker.apply(.windowTitle("server.go"), at: .now)

        #expect(end(events[0])?.reason == .windowChange)
        #expect(start(events[1])?.appName == "Code")
        #expect(start(events[1])?.windowTitle == "server.go")
    }

    @Test func idleClosesTheSpanAndNothingOpensUntilActive() {
        var tracker = makeTracker()
        _ = tracker.apply(.frontmost(editor, windowTitle: "main.go"), at: .now)

        let idle = tracker.apply(.idle(since: .now), at: .now)
        #expect(idle.count == 1)
        #expect(end(idle[0])?.reason == .idle)
        #expect(tracker.apply(.windowTitle("other.go"), at: .now).isEmpty)
        #expect(tracker.openSpan == nil)

        let resumed = tracker.apply(.active, at: .now)
        #expect(resumed.count == 1)
        #expect(start(resumed[0])?.id == "span-2")
    }

    @Test func idleEndsTheSpanAtTheLastInputButNotBeforeItStarted() {
        let opened = Date(timeIntervalSince1970: 1000)
        var tracker = makeTracker()
        _ = tracker.apply(.frontmost(editor, windowTitle: "main.go"), at: opened)
        #expect(end(tracker.apply(.idle(since: opened + 5), at: opened + 65)[0])?.endedAt == opened + 5)

        _ = tracker.apply(.active, at: opened + 100)
        #expect(end(tracker.apply(.idle(since: opened + 90), at: opened + 150)[0])?.endedAt == opened + 100)
    }

    @Test func anIgnoredBundleIDLeavesTheSpanOpen() {
        var tracker = makeTracker()
        _ = tracker.apply(.frontmost(editor, windowTitle: "main.go"), at: .now)

        #expect(tracker.apply(.frontmost(dock, windowTitle: nil), at: .now).isEmpty)
        #expect(tracker.apply(.frontmost(editor, windowTitle: "main.go"), at: .now).isEmpty)
        #expect(tracker.openSpan?.target == editor)
    }

    @Test func aDirectionalityMarkIsTrimmedFromTheAppName() {
        #expect(FocusTarget(bundleID: "net.whatsapp.WhatsApp", appName: "\u{200E}WhatsApp").appName == "WhatsApp")
    }

    @Test func aSkippedBundleIDOpensNoSpan() {
        var tracker = makeTracker()
        _ = tracker.apply(.frontmost(editor, windowTitle: "main.go"), at: .now)

        let events = tracker.apply(.frontmost(chrome, windowTitle: "Hacker News"), at: .now)

        #expect(events.count == 1)
        #expect(end(events[0])?.reason == .appSwitch)
        #expect(tracker.openSpan == nil)
    }

    @Test func aPrivateBundleIDOpensASpanWithoutATitle() {
        var tracker = makeTracker()

        let events = tracker.apply(.frontmost(vault, windowTitle: "AWS root"), at: .now)

        #expect(start(events[0])?.appName == "1Password")
        #expect(start(events[0])?.windowTitle == nil)
        #expect(tracker.apply(.windowTitle("Bank"), at: .now).isEmpty)
    }
}
