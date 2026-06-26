import SwiftUI

/// At-a-glance weather: current conditions plus a short daily outlook. Owns its
/// own glass chrome and only renders inside the expanded home surface, so it
/// never animates while the notch is idle.
struct WeatherWidgetView: View {
    @EnvironmentObject private var weather: WeatherManager

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let snapshot = weather.snapshot {
                current(snapshot)
                Spacer(minLength: 6)
                forecast(snapshot.daily)
            } else {
                placeholder
            }
        }
        .notchCard()
        .accessibilityElement(children: .combine)
    }

    // MARK: - Current conditions

    private func current(_ s: WeatherSnapshot) -> some View {
        HStack(spacing: 10) {
            Image(systemName: s.symbolName)
                .font(.system(size: 26, weight: .medium))
                .symbolRenderingMode(.multicolor)
                .frame(width: 32, height: 32)

            VStack(alignment: .leading, spacing: 1) {
                Text("\(Int(s.temperature.rounded()))\(s.unit.suffix)")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)
                    .contentTransition(.numericText())
                    .animation(.snappy, value: s.temperature)

                Text(s.conditionText)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(1)

                if let location = s.locationName, !location.isEmpty {
                    Text(location)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.5))
                        .lineLimit(1)
                }
            }
        }
    }

    // MARK: - Daily outlook

    @ViewBuilder
    private func forecast(_ days: [WeatherDay]) -> some View {
        let visible = Array(days.prefix(4))
        if !visible.isEmpty {
            HStack(alignment: .top, spacing: 0) {
                ForEach(visible) { day in
                    VStack(spacing: 3) {
                        Text(weekday(for: day.date))
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.white.opacity(0.7))

                        Image(systemName: day.symbolName)
                            .font(.system(size: 13))
                            .symbolRenderingMode(.multicolor)
                            .frame(height: 16)

                        Text("\(Int(day.high.rounded()))°")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)

                        Text("\(Int(day.low.rounded()))°")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.55))
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    // MARK: - Placeholder

    private var placeholder: some View {
        HStack(spacing: 10) {
            Image(systemName: "cloud.slash")
                .font(.system(size: 22))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.white.opacity(0.6))

            VStack(alignment: .leading, spacing: 1) {
                Text("—")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)

                Text("Weather unavailable")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
    }

    private func weekday(for date: Date) -> String {
        date.formatted(.dateTime.weekday(.abbreviated))
    }
}
