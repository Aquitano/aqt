import SwiftUI

/// Coordinate space the drop zones report their frames in, so the root drop
/// delegate can hit-test the drag location against them.
let notchDropSpace = "notchDropSpace"

/// Published frames of the two drop fields, keyed by zone, in `notchDropSpace`.
struct DropZoneFrameKey: PreferenceKey {
    static let defaultValue: [DropZone: CGRect] = [:]
    static func reduce(value: inout [DropZone: CGRect], nextValue: () -> [DropZone: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// Shown inside the expanded notch while a file drag is in progress: two side-by-side
/// drop fields. The left one stages the files on the shelf; the right one shares the
/// drop straight away via the configured method (AirDrop / Blip). The fields are
/// pure visuals — the actual drop is routed by `NotchDropDelegate` on the root.
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
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.white.opacity(targeted ? 0.16 : 0.05))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(
                                .white.opacity(targeted ? 0.5 : 0.18),
                                style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])
                            )
                    }
                GeometryReader { geo in
                    Color.clear.preference(
                        key: DropZoneFrameKey.self,
                        value: [id: geo.frame(in: .named(notchDropSpace))]
                    )
                }
            }
        }
        .scaleEffect(targeted ? 1.02 : 1)
        .animation(.snappy(duration: 0.18), value: targeted)
    }
}
