import NotchCore
import SwiftUI

/// Wall-clock tile, optionally with a second time zone. The scoped
/// `TimelineView(.everyMinute)` only ticks while the expanded surface is
/// rendered (hidden panels are ordered out), so idle costs nothing — the same
/// pattern as the timer pill.
struct ClockWidgetView: View {
    @Environment(Settings.self) private var settings

    var body: some View {
        TimelineView(.everyMinute) { context in
            VStack(alignment: .leading, spacing: 0) {
                PixelIcon(
                    systemName: "clock",
                    size: 17,
                    tint: .white.opacity(0.7)
                )

                Spacer(minLength: 4)

                Text(context.date, format: .dateTime.hour().minute())
                    .font(.title.weight(.semibold))
                    .foregroundStyle(.white)
                    .monospacedDigit()

                if let zone = secondaryZone {
                    Text("\(context.date, format: Date.FormatStyle(timeZone: zone).hour().minute()) \(zoneLabel(zone))")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .notchCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Clock")
    }

    private var secondaryZone: TimeZone? {
        let identifier = settings.widgets.clockSecondaryTimeZone
        guard !identifier.isEmpty else { return nil }
        return TimeZone(identifier: identifier)
    }

    private func zoneLabel(_ zone: TimeZone) -> String {
        zone.identifier.split(separator: "/").last
            .map { $0.replacingOccurrences(of: "_", with: " ") } ?? zone.identifier
    }
}
