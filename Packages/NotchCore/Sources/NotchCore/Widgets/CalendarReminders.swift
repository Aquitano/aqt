import Foundation

/// A pending "starts in 5 min" peek: when to fire and what to say.
package struct CalendarReminder: Equatable {
    package let fireAt: Date
    package let title: String
}

/// Decides which upcoming events still warrant a reminder peek, pulled out of
/// `CalendarManager` so the filtering runs without EventKit or a live clock.
/// All-day events never remind; an event whose lead time has already passed is
/// dropped. Pure so the "which events, when" rule is a table-test.
package enum CalendarReminders {
    package static func pending(events: [CalendarEvent], now: Date, lead: TimeInterval) -> [CalendarReminder] {
        events.compactMap { event in
            guard !event.isAllDay else { return nil }
            let fireAt = event.start.addingTimeInterval(-lead)
            guard fireAt > now else { return nil }
            return CalendarReminder(fireAt: fireAt, title: event.title)
        }
    }
}
