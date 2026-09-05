import NotchCore
import SwiftUI

/// Battery status tile: a drawn level indicator, a one-tap Low Power Mode leaf,
/// the percentage, and a status line (charging / time remaining). Static by
/// design, so it adds no animation cost while the panel is open.
struct BatteryWidgetView: View {
    @Environment(BatteryManager.self) var battery
    @Environment(PowerModeController.self) var powerMode

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                BatteryIndicator(level: battery.percent, charging: battery.isCharging, tint: indicatorTint)
                lowPowerButton
                Spacer(minLength: 0)
            }

            Spacer(minLength: 4)

            Text("\(battery.percent)%")
                .font(.title.weight(.semibold))
                .foregroundStyle(.white)
                .contentTransition(.numericText())
                .animation(.snappy, value: battery.percent)

            if let status = statusLine {
                Text(status)
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
        }
        .notchCard()
        .onAppear { powerMode.refreshAvailability() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Battery \(battery.percent) percent\(battery.isCharging ? ", charging" : "")")
    }

    /// Sits inline where the old passive leaf badge lived, at the same 12pt
    /// glyph size so the status row keeps its height; padding supplies the tap
    /// target without inflating the layout.
    private var lowPowerButton: some View {
        Button {
            Haptics.tap(.levelChange)
            powerMode.toggle()
        } label: {
            PixelIcon(
                systemName: "leaf.fill",
                size: 12,
                tint: battery.lowPowerMode ? .yellow : .white.opacity(0.35)
            )
            .padding(4)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .frame(height: 14)
        .opacity(powerMode.isToggling ? 0.5 : 1)
        .disabled(powerMode.isToggling)
        .help(battery.lowPowerMode ? "Turn off Low Power Mode" : "Turn on Low Power Mode")
        .accessibilityLabel(battery.lowPowerMode ? "Turn off Low Power Mode" : "Turn on Low Power Mode")
    }

    // MARK: - Derived content

    private var indicatorTint: Color {
        if battery.isCharging || battery.isFullyCharged {
            return .green
        }
        if battery.percent <= 20 {
            return .red
        }
        return .white
    }

    private var statusLine: String? {
        if battery.isCharging {
            return "Charging"
        }
        if battery.isFullyCharged {
            return "Charged"
        }
        if let minutes = battery.timeToEmpty {
            return Self.timeLeft(minutes: minutes)
        }
        return nil
    }

    private static func timeLeft(minutes: Int) -> String {
        let hours = minutes / 60
        let mins = minutes % 60
        return hours > 0 ? "\(hours)h \(mins)m left" : "\(mins)m left"
    }
}
