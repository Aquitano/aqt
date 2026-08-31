import SwiftUI

/// Auto-dismissing volume/brightness capsule that sits just below the notch:
/// glyph, a quiet name, the level bar, and the percentage. Visibility and the
/// open/close transition are owned by `HUDManager` and the root view; this is a
/// pure readout, so it never drives its own animation loop.
struct HUDOverlayView: View {
    let namespace: Namespace.ID

    @EnvironmentObject private var hud: HUDManager

    var body: some View {
        HStack(spacing: 10) {
            PixelIcon(systemName: hud.muted ? "speaker.slash.fill" : hud.kind.symbol,
                      size: 16, tint: .white)
                .frame(width: 20)

            Text(hud.kind.title)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)

            Spacer(minLength: 8)

            progressBar
                .frame(width: 96)

            Text("\(percent)")
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 26, alignment: .trailing)
                .contentTransition(.numericText())
                .animation(.snappy(duration: 0.15), value: percent)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 18)
        .frame(width: 264, height: 44)
        .glassEffect(.regular, in: .capsule)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.22))
                Capsule()
                    .fill(barTint)
                    .frame(width: max(geo.size.height, geo.size.width * clampedValue))
            }
        }
        .frame(height: 6)
        .animation(.easeOut(duration: 0.15), value: clampedValue)
    }

    /// Brightness reads warm (a sun-yellow bar); volume stays white. Muted dims
    /// the bar rather than hiding it, so the level survives the state.
    private var barTint: Color {
        switch hud.kind {
        case .brightness: return .yellow
        case .volume: return .white
        case .mute: return .white.opacity(0.35)
        }
    }

    private var clampedValue: Double { min(max(hud.value, 0), 1) }

    private var percent: Int { Int((clampedValue * 100).rounded()) }

    private var accessibilityLabel: String {
        if hud.muted { return "Muted" }
        return "\(hud.kind.title) \(percent) percent"
    }
}
