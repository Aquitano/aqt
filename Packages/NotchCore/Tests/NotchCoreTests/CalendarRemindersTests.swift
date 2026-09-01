import Foundation
import Testing
@testable import NotchCore

/// `CalendarReminders.pending` is a pure filter over events + clock, so the
/// all-day exclusion, the lead-time window, and per-occurrence fan-out are
/// table-tested here without EventKit.
struct CalendarRemindersTests {

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

    @Test func timedEventBeyondLeadReminds() {
        let out = CalendarReminders.pending(events: [event("Standup", startsInMinutes: 10)], now: now, lead: lead)
        #expect(out == [CalendarReminder(fireAt: now.addingTimeInterval(5 * 60), title: "Standup")])
    }

    @Test func eventInsideLeadWindowIsDropped() {
        // Starts in 4 min, so its 5-min-before mark is already in the past.
        let out = CalendarReminders.pending(events: [event("Soon", startsInMinutes: 4)], now: now, lead: lead)
        #expect(out.isEmpty)
    }

    @Test func pastEventIsDropped() {
        let out = CalendarReminders.pending(events: [event("Earlier", startsInMinutes: -30)], now: now, lead: lead)
        #expect(out.isEmpty)
    }

    @Test func allDayEventNeverReminds() {
        let out = CalendarReminders.pending(events: [event("Holiday", startsInMinutes: 120, isAllDay: true)], now: now, lead: lead)
        #expect(out.isEmpty)
    }

    @Test func eachOccurrenceGetsItsOwnReminder() {
        // Recurring occurrences share an id; the filter must keep them distinct.
        let events = [event("Sync", startsInMinutes: 10), event("Sync", startsInMinutes: 70)]
        let out = CalendarReminders.pending(events: events, now: now, lead: lead)
        #expect(out.map(\.fireAt) == [now.addingTimeInterval(5 * 60), now.addingTimeInterval(65 * 60)])
    }
}
