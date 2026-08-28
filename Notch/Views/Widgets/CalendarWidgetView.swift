import SwiftUI
import AppKit
import EventKit

/// Glass card listing the next few calendar events, or an access prompt when
/// calendar permission hasn't been granted. Lives inside the expanded panel,
/// so glass on the card is fine.
struct CalendarWidgetView: View {
    @EnvironmentObject private var calendar: CalendarManager

    private let maxEvents = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TileHeader(title: "Calendar", systemImage: "calendar")

            if calendar.authorization != .fullAccess {
                accessPrompt
            } else if upcoming.isEmpty {
                Spacer(minLength: 0)
                Text("No upcoming events")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.5))
                Spacer(minLength: 0)
            } else {
                ForEach(upcoming) { event in
                    row(for: event)
                }
                Spacer(minLength: 0)
            }
        }
        .notchCard()
    }

    private var upcoming: [CalendarEvent] {
        Array(calendar.events.prefix(maxEvents))
    }

    // MARK: - Access prompt

    private var accessPrompt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("See your next events at a glance.")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.55))
                .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await calendar.requestAccess() }
            } label: {
                Text("Enable Calendar")
                    .font(.callout.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Event row

    private func row(for event: CalendarEvent) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color(for: event))
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 1) {
                Text(event.title)
                    .font(.caption.weight(event.isInProgress ? .semibold : .regular))
                    .lineLimit(1)
                Text(timeText(for: event))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 4)

            if let url = event.conferenceURL {
                Button("Join") { NSWorkspace.shared.open(url) }
                    .font(.caption.weight(.medium))
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
        .opacity(event.isInProgress ? 1 : 0.85)
    }

    // MARK: - Helpers

    private func color(for event: CalendarEvent) -> Color {
        Color(hex: event.calendarColorHex ?? "") ?? .accentColor
    }

    private func timeText(for event: CalendarEvent) -> String {
        event.isAllDay ? "All day" : event.start.formatted(date: .omitted, time: .shortened)
    }
}
