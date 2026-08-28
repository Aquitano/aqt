import SwiftUI

/// Letter→app hint grid, shown after a bare 400 ms rcmd hold (BATTLEPLAN
/// Phase 7). Bottom-center pill; disappears the moment a key is pressed or
/// rcmd is released.
@MainActor
final class HintHUD {
    static let shared = HintHUD()

    private var panel: HudPanel?

    func show(entries: [HintEntry]) {
        guard !entries.isEmpty else { return }
        let width: CGFloat = 620
        let height: CGFloat = CGFloat((entries.count + 7) / 8) * 44 + 24

        let screen = HudPanel.mainScreenBounds
        let frame = NSRect(
            x: screen.midX - width / 2,
            y: screen.minY + 64,
            width: width,
            height: height
        )

        let panel = self.panel ?? HudPanel(contentRect: frame)
        self.panel = panel
        let hosting = NSHostingView(rootView: HintGrid(entries: entries).themeAccessibility())
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.setFrame(frame, display: true)

        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    /// Instant: the hint grid disappears the moment a key lands, and a fade
    /// there would trail behind the switch it triggered.
    func hide() {
        panel?.orderOut(nil)
    }
}

struct HintEntry: Identifiable {
    let letter: Character
    let bundleID: String
    var id: Character { letter }
}

private struct HintGrid: View {
    let entries: [HintEntry]

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: Theme.Metrics.grid), count: 8),
            spacing: Theme.Metrics.grid
        ) {
            ForEach(entries) { entry in
                HStack(spacing: 6) {
                    KeyCap(character: entry.letter)
                    if let icon = AppIcons.icon(for: entry.bundleID) {
                        Image(nsImage: icon)
                            .resizable()
                            .frame(width: 22, height: 22)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(Theme.Metrics.grid * 1.5)
        .frame(width: 620)
        .frame(maxHeight: .infinity)
        .background(SurfaceBackground())
        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.panelRadius))
    }
}
