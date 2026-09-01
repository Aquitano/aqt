import SwiftUI
import NotchCore

/// Reusable circular control for the expanded chrome (transport, tray actions,
/// tab bar). Glass sits on content only, never on the black pill, so callers
/// must keep it inside expanded surfaces.
struct GlassButton: View {
    let systemName: String
    var size: CGFloat = 34
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            PixelIcon(systemName: systemName, size: size * 0.46, tint: .primary)
                .frame(width: size, height: size)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular, in: .circle)
        .scaleEffect(hovering && !reduceMotion ? 1.04 : 1)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: hovering)
        .onHover { hovering = $0 }
        .accessibilityLabel(Self.label(for: systemName))
        .accessibilityAddTraits(.isButton)
    }

    /// "play.fill" -> "play" so VoiceOver reads the action, not the glyph name.
    private static func label(for systemName: String) -> String {
        systemName
            .replacingOccurrences(of: ".fill", with: "")
            .replacingOccurrences(of: ".circle", with: "")
            .replacingOccurrences(of: ".", with: " ")
    }
}
