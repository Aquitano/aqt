import SwiftUI
import CoreLocation

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
            } else if needsLocationAccess {
                accessPrompt
            } else if weather.fetchFailed {
                fetchFailedPrompt
            } else {
                placeholder
            }
        }
        .notchCard()
        .accessibilityElement(children: .combine)
    }

    /// The location prompt never fired, or was denied — offer to (re)request it.
    /// An authorized-but-empty snapshot is a transient/network gap, not a
    /// permission problem, so it keeps the plain placeholder.
    private var needsLocationAccess: Bool {
        switch weather.authorization {
        case .notDetermined, .denied, .restricted: return true
        default: return false
        }
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

                // Condition and place on one line so the card leaves room for the
                // daily outlook below instead of clipping it.
                Text(subtitle(s))
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(1)
            }
        }
    }

    private func subtitle(_ s: WeatherSnapshot) -> String {
        guard let location = s.locationName, !location.isEmpty else { return s.conditionText }
        return "\(s.conditionText) · \(location)"
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

                        // High and low share a line to keep the row to a single
                        // compact band that fits inside the card.
                        HStack(spacing: 3) {
                            Text("\(Int(day.high.rounded()))°")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.white)
                            Text("\(Int(day.low.rounded()))°")
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.55))
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    // MARK: - Access prompt

    /// Authorized but the fetch failed with nothing cached — say so and offer a
    /// retry instead of the ambiguous em-dash placeholder.
    private var fetchFailedPrompt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 22))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.white.opacity(0.6))

            Text("Couldn't load the weather.")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.55))
                .fixedSize(horizontal: false, vertical: true)

            Button {
                weather.refresh()
            } label: {
                Text("Retry")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
    }

    private var accessPrompt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "location.slash")
                .font(.system(size: 22))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.white.opacity(0.6))

            Text("Show local weather for your location.")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.55))
                .fixedSize(horizontal: false, vertical: true)

            Button {
                weather.requestAccess()
            } label: {
                Text("Enable Location")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - Placeholder

    private var placeholder: some View {
        HStack(spacing: 10) {
            Image(systemName: "location.slash")
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
