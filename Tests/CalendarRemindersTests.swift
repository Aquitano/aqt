import XCTest

/// `CalendarReminders.pending` is a pure filter over events + clock, so the
/// all-day exclusion, the lead-time window, and per-occurrence fan-out are
/// table-tested here without EventKit.
final class CalendarRemindersTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private let lead: TimeInterval = 5 * 60

    private func event(
        _ title: String,
        startsInMinutes minutes: Double,
        isAllDay: Bool = false
    ) -> CalendarEvent {
        let start = now.addingTimeInterval(minutes * 60)
        return CalendarEvent(
            id: title, title: title, start: start, end: start.addingTimeInterval(3600),
            isAllDay: isAllDay, calendarColorHex: nil, location: nil, conferenceURL: nil
        )
    }

    func testTimedEventBeyondLeadReminds() {
        let out = CalendarReminders.pending(events: [event("Standup", startsInMinutes: 10)], now: now, lead: lead)
        XCTAssertEqual(out, [CalendarReminder(fireAt: now.addingTimeInterval(5 * 60), title: "Standup")])
    }

    func testEventInsideLeadWindowIsDropped() {
        // Starts in 4 min, so its 5-min-before mark is already in the past.
        let out = CalendarReminders.pending(events: [event("Soon", startsInMinutes: 4)], now: now, lead: lead)
        XCTAssertTrue(out.isEmpty)
    }

    func testPastEventIsDropped() {
        let out = CalendarReminders.pending(events: [event("Earlier", startsInMinutes: -30)], now: now, lead: lead)
        XCTAssertTrue(out.isEmpty)
    }

    func testAllDayEventNeverReminds() {
        let out = CalendarReminders.pending(events: [event("Holiday", startsInMinutes: 120, isAllDay: true)], now: now, lead: lead)
        XCTAssertTrue(out.isEmpty)
    }

    func testEachOccurrenceGetsItsOwnReminder() {
        // Recurring occurrences share an id; the filter must keep them distinct.
        let events = [event("Sync", startsInMinutes: 10), event("Sync", startsInMinutes: 70)]
        let out = CalendarReminders.pending(events: events, now: now, lead: lead)
        XCTAssertEqual(out.map(\.fireAt), [now.addingTimeInterval(5 * 60), now.addingTimeInterval(65 * 60)])
    }
}
