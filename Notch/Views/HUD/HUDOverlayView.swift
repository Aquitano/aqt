import SwiftUI

/// Auto-dismissing volume/brightness chiclet that sits just below the notch.
/// Visibility and the open/close transition are owned by `HUDManager` and the
/// root view; this is a pure readout, so it never drives its own animation loop.
struct HUDOverlayView: View {
    let namespace: Namespace.ID

    @EnvironmentObject private var hud: HUDManager

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: hud.muted ? "speaker.slash.fill" : hud.kind.symbol)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 22)
                .contentTransition(.symbolEffect(.replace))

            progressBar

            Text("\(percent)")
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .frame(width: 28, alignment: .trailing)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .frame(width: 180, height: 44)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.25))
                Capsule()
                    .fill(.white)
                    .frame(width: geo.size.width * clampedValue)
            }
        }
        .frame(height: 6)
        .animation(.easeOut(duration: 0.15), value: clampedValue)
    }

    private var clampedValue: Double { min(max(hud.value, 0), 1) }

    private var percent: Int { Int((clampedValue * 100).rounded()) }

    private var accessibilityLabel: String {
        if hud.muted { return "Muted" }
        let prefix = hud.kind == .brightness ? "Brightness" : "Volume"
        return "\(prefix) \(percent) percent"
    }
}
