import NotchCore
import SwiftUI

/// Pinned Shortcuts as one-tap run buttons. The pin list lives in Settings; run
/// failures surface via the activity peek channel (see ShortcutsManager).
struct ShortcutsWidgetView: View {
    @Environment(Settings.self) private var settings
    @Environment(ShortcutsManager.self) private var shortcuts

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                PixelIcon(
                    systemName: "square.2.layers.3d",
                    size: 15,
                    tint: .white.opacity(0.7)
                )
                Text("Shortcuts")
                    .font(.headline)
                    .foregroundStyle(.white)
                Spacer(minLength: 0)
            }

            if settings.widgets.pinnedShortcuts.isEmpty {
                Text("Pin shortcuts in Settings to run them from here.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.45))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                    ForEach(settings.widgets.pinnedShortcuts, id: \.self) { name in
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
