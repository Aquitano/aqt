import SwiftUI

/// Pinned Shortcuts as one-tap run buttons. The pin list lives in Settings; run
/// failures surface via the activity peek channel (see ShortcutsManager).
struct ShortcutsWidgetView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var shortcuts: ShortcutsManager

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "square.2.layers.3d")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
                Text("Shortcuts")
                    .font(.headline)
                    .foregroundStyle(.white)
                Spacer(minLength: 0)
            }

            if settings.pinnedShortcuts.isEmpty {
                Text("Pin shortcuts in Settings to run them from here.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.45))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                    ForEach(settings.pinnedShortcuts, id: \.self) { name in
                        Button {
                            shortcuts.run(name)
                        } label: {
                            Text(name)
                                .font(.callout)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(.white)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .notchCard()
    }
}
