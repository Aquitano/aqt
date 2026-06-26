import EventKit
import AppKit
import Combine

/// Upcoming events from a single EKEventStore. Reloads on `.EKEventStoreChanged`
/// (no polling). Flattens EKEvent into our value type so views never see EventKit.
@MainActor
final class CalendarManager: ObservableObject {

    @Published private(set) var events: [CalendarEvent] = []
    @Published private(set) var authorization: EKAuthorizationStatus = .notDetermined

    private let store = EKEventStore()
    private let horizonDays = 7

    func start() {
        authorization = EKEventStore.authorizationStatus(for: .event)
        NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged, object: store, queue: .main
        ) { [weak self] _ in
            self?.reload()
        }
        Task { await requestAccess() }
    }

    func requestAccess() async {
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
            return
        }
        let now = Date()
        guard let end = Calendar.current.date(byAdding: .day, value: horizonDays, to: now) else { return }
        let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
        let matched = store.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }
            .prefix(25)
        events = matched.map(Self.map)
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
