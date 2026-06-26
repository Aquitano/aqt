import SwiftUI

/// At-a-glance Focus badge for the expanded home surface. Owns its own glass
/// chrome and tints up when a Focus is active. Lives inside the expanded panel,
/// so it never renders while the notch is idle.
struct FocusWidgetView: View {
    @EnvironmentObject private var focus: FocusManager

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: focus.isOn ? "moon.fill" : "moon")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(focus.isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.white.opacity(0.7)))

            Spacer(minLength: 4)

            Text(focus.name ?? "Focus")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)

            Text(focus.isOn ? "On" : "Off")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.6))
        }
        .notchCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Focus \(focus.name ?? "") \(focus.isOn ? "on" : "off")")
    }
}
