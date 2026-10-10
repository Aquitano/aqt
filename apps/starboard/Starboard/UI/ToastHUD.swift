import SwiftUI

/// A short message at the bottom of the screen under the pointer. It fades
/// out after 1.8 seconds, or goes at once on a click.
@MainActor
final class ToastHUD {
    private var panel: HudPanel?
    private var dismissTask: Task<Void, Never>?
    /// Counts toasts, so a fade-out that ends after a newer toast appeared
    /// leaves the newer one on screen.
    private var shown = 0

    func show(appName: String, letter: Character, icon: NSImage?) {
        present { dismiss in
            Toast(dismiss: dismiss) {
                HStack(spacing: Theme.Metrics.grid * 1.5) {
                    if let icon {
                        Image(nsImage: icon)
                            .resizable()
                            .frame(width: 24, height: 24)
                    }
                    Text("Pinned **\(appName)** to")
                    KeyTag(label: letter.uppercased())
                }
            }
        }
    }

    func show(message: String) {
        present { dismiss in
            Toast(dismiss: dismiss) { Text(message).lineLimit(1) }
        }
    }

    private func present(_ content: (@escaping () -> Void) -> some View) {
        dismissTask?.cancel()
        shown += 1
        let current = shown

        let screen = HudPanel.pointerScreenFrame
        let frame = NSRect(x: screen.midX - 180, y: screen.minY + 72, width: 360, height: 52)
        let panel = self.panel ?? HudPanel(contentRect: frame)
        self.panel = panel

        let hosting = NSHostingView(rootView: content { [weak panel] in panel?.orderOut(nil) })
        // The panel keeps its frame; sizing to the content would shrink it.
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.setFrame(frame, display: true)
        // The previous toast may have faded the panel out. The new content
        // fades itself in.
        panel.alphaValue = 1
        panel.orderFrontRegardless()

        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.8))
            guard !Task.isCancelled else { return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.1
                panel.animator().alphaValue = 0
            } completionHandler: {
                // AppKit runs animation completions on the main thread.
                MainActor.assumeIsolated {
                    if self?.shown == current {
                        panel.orderOut(nil)
                    }
                }
            }
        }
    }
}

private struct Toast<Content: View>: View {
    let dismiss: () -> Void
    @ViewBuilder let content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false

    var body: some View {
        content
            .font(.system(size: 13))
            .padding(.horizontal, Theme.Metrics.grid * 2.5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(SurfaceBackground())
            .scaleEffect(reduceMotion || visible ? 1 : 0.98)
            .opacity(visible ? 1 : 0)
            .animation(Theme.Motion.toastIn, value: visible)
            .onAppear { visible = true }
            .onTapGesture(perform: dismiss)
    }
}
