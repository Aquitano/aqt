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
        panel.setFrame(frame, display: true)
        panel.contentView = NSHostingView(rootView: HintGrid(entries: entries))

        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    func hide() {
        guard let panel, panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: { panel.orderOut(nil) })
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
                    if let icon = StageSaveView.icon(for: entry.bundleID) {
                        Image(nsImage: icon)
                            .resizable()
                            .frame(width: 22, height: 22)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(Theme.Metrics.grid * 1.5)
        .background(SurfaceBackground())
        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.panelRadius))
    }
}
