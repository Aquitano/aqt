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
                title: keepTitle,
                subtitle: keepSubtitle,
                systemImage: "tray.and.arrow.down.fill"
            )
            zone(
                .share,
                title: shareTitle,
                subtitle: shareSubtitle,
                systemImage: shareSymbol
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var keepTitle: String {
        switch state.activeDropRepresentation {
        case .webURL: return "Keep Link"
        case .plainText: return "Keep Text"
        default: return "Keep"
        }
    }

    private var keepSubtitle: String { "Add to Shelf" }

    private var shareTitle: String {
        state.activeDropRepresentation == .webURL
            ? "Open / Share"
            : settings.shareMethod.actionTitle
    }

    private var shareSubtitle: String {
        state.activeDropRepresentation == .plainText ? "Share text" : "Share now"
    }

    private var shareSymbol: String {
        state.activeDropRepresentation == .webURL ? "link" : settings.shareMethod.symbol
    }

    private func zone(_ id: DropZone, title: String, subtitle: String, systemImage: String) -> some View {
        let targeted = state.activeDropZone == id
        return VStack(spacing: 8) {
            PixelIcon(systemName: systemImage, size: 28,
                      tint: .white.opacity(targeted ? 1 : 0.85))
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
        .animation(state.reduceMotion ? nil : .snappy(duration: 0.18), value: targeted)
    }
}
