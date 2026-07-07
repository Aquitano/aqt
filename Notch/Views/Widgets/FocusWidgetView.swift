import SwiftUI

/// At-a-glance Focus badge for the expanded home surface. Owns its own glass
/// chrome and tints up when a Focus is active. Lives inside the expanded panel,
/// so it never renders while the notch is idle.
struct FocusWidgetView: View {
    @EnvironmentObject private var focus: FocusManager

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if focus.authorized {
                status
            } else {
                accessPrompt
            }
        }
        .notchCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(focus.authorized
            ? "Focus \(focus.name ?? "") \(focus.isOn ? "on" : "off")"
            : "Focus access needed")
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: focus.isOn ? "moon.fill" : "moon")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(focus.isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.white.opacity(0.7)))

            Spacer(minLength: 4)

            Text(focus.name ?? "Focus")
                .font(.headline)
                .foregroundStyle(.white)
                .lineLimit(1)

            Text(focus.isOn ? "On" : "Off")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.6))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Focus access was never granted (or was denied); without this the tile would
    /// confidently show "Off" for an unknown state, unfixable from the UI.
    private var accessPrompt: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: "moon.zzz")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))

            Spacer(minLength: 4)

            Button {
                focus.requestAccess()
            } label: {
                Text("Enable")
                    .font(.callout.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
