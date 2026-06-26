import SwiftUI

/// At-a-glance Focus badge for the expanded home surface. Owns its own glass
/// chrome and tints up when a Focus is active. Lives inside the expanded panel,
/// so it never renders while the notch is idle.
struct FocusWidgetView: View {
    @EnvironmentObject private var focus: FocusManager

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: focus.isOn ? "moon.fill" : "moon")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(focus.isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))

            Text(focus.name ?? "Focus")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)

            Text(focus.isOn ? "On" : "Off")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
        .onAppear { focus.refresh() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Focus \(focus.name ?? "") \(focus.isOn ? "on" : "off")")
    }
}
