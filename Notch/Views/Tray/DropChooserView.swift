import SwiftUI

/// Shown inside the expanded notch while a file drag is in progress: two side-by-side
/// drop fields. The left one stages the files on the shelf; the right one shares the
/// drop straight away via the configured method (AirDrop / Blip). The fields are
/// pure visuals — `state.activeDropZone` drives the highlight and the root
/// `NotchDropDelegate` routes the actual drop by cursor position.
struct DropChooserView: View {
    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var settings: Settings

    var body: some View {
        HStack(spacing: 12) {
            zone(
                .keep,
                title: "Keep",
                subtitle: "Add to shelf",
                systemImage: "tray.and.arrow.down.fill"
            )
            zone(
                .share,
                title: settings.shareMethod.actionTitle,
                subtitle: "Share now",
                systemImage: settings.shareMethod.symbol
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func zone(_ id: DropZone, title: String, subtitle: String, systemImage: String) -> some View {
        let targeted = state.activeDropZone == id
        return VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 26, weight: .regular))
                .symbolRenderingMode(.hierarchical)
            VStack(spacing: 2) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
        .foregroundStyle(.white.opacity(targeted ? 1 : 0.85))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.white.opacity(targeted ? 0.16 : 0.05))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(
                            .white.opacity(targeted ? 0.5 : 0.18),
                            style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])
                        )
                }
        }
        .scaleEffect(targeted ? 1.02 : 1)
        .animation(.snappy(duration: 0.18), value: targeted)
    }
}
