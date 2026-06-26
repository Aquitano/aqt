import SwiftUI

/// Battery glass card for the expanded widget grid: level glyph, percentage, and
/// a status line (charging / time remaining). Static by design, so it adds no
/// animation cost while the panel is open.
struct BatteryWidgetView: View {
    @EnvironmentObject var battery: BatteryManager

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Image(systemName: symbolName)
                    .font(.system(size: 22, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(iconTint)

                Spacer(minLength: 0)

                if battery.lowPowerMode {
                    lowPowerBadge
                }
            }

            VStack(alignment: .leading, spacing: 1) {
                Text("\(battery.percent)%")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)

                if let status = statusLine {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.65))
                        .lineLimit(1)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }

    private var lowPowerBadge: some View {
        HStack(spacing: 3) {
            Image(systemName: "leaf.fill")
            Text("Low Power")
        }
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.yellow)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(.yellow.opacity(0.15), in: .capsule)
    }

    // MARK: - Derived content

    /// SF Symbols only ships the five quarter-step battery glyphs, so snap the
    /// real percentage to the nearest bucket before building the name.
    private var symbolName: String {
        let level: Int
        switch battery.percent {
        case ..<13: level = 0
        case ..<38: level = 25
        case ..<63: level = 50
        case ..<88: level = 75
        default: level = 100
        }
        return battery.isCharging ? "battery.\(level).bolt" : "battery.\(level)"
    }

    private var iconTint: Color {
        if battery.isCharging || battery.isFullyCharged { return .green }
        if battery.percent <= 20 { return .red }
        return .white
    }

    private var statusLine: String? {
        if battery.isCharging { return "Charging" }
        if battery.isFullyCharged { return "Charged" }
        if let minutes = battery.timeToEmpty { return Self.timeLeft(minutes: minutes) }
        return nil
    }

    private static func timeLeft(minutes: Int) -> String {
        let hours = minutes / 60
        let mins = minutes % 60
        return hours > 0 ? "\(hours)h \(mins)m left" : "\(mins)m left"
    }
}
