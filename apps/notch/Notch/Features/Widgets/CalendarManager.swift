import AppKit
import EventKit
import NotchCore

/// Upcoming events from a single EKEventStore. Reloads on `.EKEventStoreChanged`
/// (no polling). Flattens EKEvent into our value type so views never see EventKit.
@MainActor
@Observable
final class CalendarManager {
    private(set) var events: [CalendarEvent] = []
    private(set) var authorization: EKAuthorizationStatus = .notDetermined

    private let store = EKEventStore()
    private let horizonDays = 7

    private unowned let activities: ActivityManager
    private var reminderTasks: [Task<Void, Never>] = []
    private let reminderLead: TimeInterval = 5 * 60
    private var cadenceTask: Task<Void, Never>?

    init(activities: ActivityManager) {
        self.activities = activities
    }

    func start() {
        authorization = EKEventStore.authorizationStatus(for: .event)
        NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged, object: store, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
        // reload() pins its window to `now`, but only .EKEventStoreChanged re-runs it.
        // Without a time axis, ended events linger, isInProgress styling goes stale,
        // and the horizon freezes at launch. Coarse timer; .common so it fires during
        // tracking too.
        cadenceTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5 * 60))
                self?.reload()
            }
        }
        // Don't trigger the TCC prompt at launch; that stacks dialogs on top of the
        // location prompt and feels like a freeze. The widget's "Enable" button asks.
        if authorization == .fullAccess {
            reload()
        }
    }

    /// Pull fresh events now — used when the home surface appears.
    func refresh() {
        reload()
    }

    func requestAccess() async {
        // Accessory apps don't auto-foreground, so the system prompt can appear
        // behind everything; bring the app forward first.
        NSApp.activate(ignoringOtherApps: true)
        do {
            _ = try await store.requestFullAccessToEvents()
        } catch {
            Log.widgets.error("Calendar access error: \(error.localizedDescription)")
        }
        authorization = EKEventStore.authorizationStatus(for: .event)
        reload()
    }

    private func reload() {
        guard authorization == .fullAccess else {
            events = []
            scheduleReminders()
            return
        }
        let now = Date()
        guard let end = Calendar.current.date(byAdding: .day, value: horizonDays, to: now) else { return }
        let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
        let matched = store.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }
            .prefix(25)
        events = matched.map(Self.map)
        scheduleReminders()
    }

    /// Fire a Quick Peek a few minutes before each timed event. One-shot
    /// `Task.sleep` per reminder (rebuilt on every reload) — no repeating timer.
    /// Recurring events share one identifier across occurrences, so the tasks live
    /// in an array rather than keyed by event id; otherwise sibling occurrences
    /// would collapse onto one slot and orphan each other's still-running tasks.
    private func scheduleReminders() {
        reminderTasks.forEach { $0.cancel() }
        reminderTasks.removeAll()

        let now = Date()
        for reminder in CalendarReminders.pending(events: events, now: now, lead: reminderLead) {
            let delay = reminder.fireAt.timeIntervalSince(now)
            let title = reminder.title
            let startsAt = reminder.fireAt.addingTimeInterval(reminderLead)
            let leadMinutes = max(1, Int((reminderLead / 60).rounded()))
            reminderTasks.append(Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                // A sleeping Mac may resume after the meeting already started. Do
                // not announce a stale reminder in that case.
                guard !Task.isCancelled, Date() < startsAt else { return }
                self?.activities.peek(
                    title: title,
                    message: "Starts in \(leadMinutes) min",
                    symbol: "calendar",
                    tint: .accent,
                    ttl: 6
                )
            })
        }
    }

    private static func map(_ event: EKEvent) -> CalendarEvent {
        CalendarEvent(
            id: event.eventIdentifier ?? UUID().uuidString,
            title: event.title ?? "(No title)",
            start: event.startDate,
            end: event.endDate,
            isAllDay: event.isAllDay,
            calendarColorHex: hex(from: event.calendar?.cgColor),
            location: event.location,
            conferenceURL: event.url
        )
    }

    private static func hex(from cgColor: CGColor?) -> String? {
        guard let cgColor,
              let color = NSColor(cgColor: cgColor)?.usingColorSpace(.sRGB) else { return nil }
        let r = Int((color.redComponent * 255).rounded())
        let g = Int((color.greenComponent * 255).rounded())
        let b = Int((color.blueComponent * 255).rounded())
        return String(format: "#%02X%02X%02X", r, g, b)
    }
}
