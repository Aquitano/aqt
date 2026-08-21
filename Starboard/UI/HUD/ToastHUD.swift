import SwiftUI

/// Base class for nonactivating overlay panels: never takes key focus, floats
/// above everything, positioned relative to the main screen.
class HudPanel: NSPanel {
    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        ignoresMouseEvents = false
    }

    /// Overlays must never take key focus from the frontmost app.
    override var canBecomeKey: Bool { false }

    static var mainScreenBounds: NSRect {
        NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }
}

/// NSVisualEffectView wrapper per BATTLEPLAN §4: hudWindow material, dark tint,
/// inner stroke, panel radius.
struct SurfaceBackground: View {
    var cornerRadius: CGFloat = Theme.Metrics.panelRadius

    var body: some View {
        VisualEffectSurface()
            .overlay {
                Rectangle()
                    .fill(Color.black.opacity(0.25))
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(Theme.Colors.stroke, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }

    private struct VisualEffectSurface: NSViewRepresentable {
        func makeNSView(context: Context) -> NSVisualEffectView {
            let view = NSVisualEffectView()
            view.material = .hudWindow
            view.blendingMode = .behindWindow
            view.state = .active
            return view
        }

        func updateNSView(_ view: NSVisualEffectView, context: Context) {}
    }
}

/// Key-cap chip for shortcut letters (BATTLEPLAN §4 type spec).
struct KeyCap: View {
    let character: Character

    var body: some View {
        Text(String(character).uppercased())
            .font(.system(size: 11, weight: .medium).monospaced())
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.white.opacity(0.1)))
            .overlay(Capsule().strokeBorder(Theme.Colors.stroke, lineWidth: 1))
            .foregroundStyle(.primary)
    }
}

/// Transient confirmation toast, bottom-center of the main screen. Used to
/// confirm letter pinning ("Pinned Slack to K"). Auto-dismisses.
final class ToastHUD {
    static let shared = ToastHUD()

    private var panel: HudPanel?
    private var dismissTask: Task<Void, Never>?

    func show(appName: String, letter: Character, icon: NSImage?) {
        present(
            ToastContent(appName: appName, letter: letter, icon: icon)
        )
    }

    /// Plain-message variant (Stages confirmations, hints).
    func show(message: String) {
        present(MessageToastContent(message: message))
    }

    private func present(_ content: some View) {
        dismissTask?.cancel()

        let panel = self.panel ?? makePanel()
        self.panel = panel

        let hosting = NSHostingView(
            rootView: content
                .environment(\.toastDismiss, { [weak panel] in panel?.orderOut(nil) })
        )
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.setFrame(placementFrame(width: 360, height: 52), display: true)

        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }

        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.8))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                NSAnimationContext.runAnimationGroup({ context in
                    context.duration = 0.1
                    panel.animator().alphaValue = 0
                }, completionHandler: { panel.orderOut(nil) })
            }
            _ = self
        }
    }

    private func makePanel() -> HudPanel {
        HudPanel(contentRect: placementFrame(width: 320, height: 56))
    }

    private func placementFrame(width: CGFloat, height: CGFloat) -> NSRect {
        let screen = HudPanel.mainScreenBounds
        return NSRect(
            x: screen.midX - width / 2,
            y: screen.minY + 72,
            width: width,
            height: height
        )
    }
}

private struct ToastDismissKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

private extension EnvironmentValues {
    var toastDismiss: () -> Void {
        get { self[ToastDismissKey.self] }
        set { self[ToastDismissKey.self] = newValue }
    }
}

private struct MessageToastContent: View {
    let message: String
    @Environment(\.toastDismiss) private var dismiss
    @State private var visible = false

    var body: some View {
        Text(message)
            .font(.system(size: 13))
            .lineLimit(1)
            .padding(.horizontal, Theme.Metrics.grid * 2.5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(SurfaceBackground())
            .scaleEffect(visible ? 1 : 0.98)
            .opacity(visible ? 1 : 0)
            .animation(Theme.Motion.overlayIn, value: visible)
            .onAppear { visible = true }
            .onTapGesture { dismiss() }
    }
}

private struct ToastContent: View {
    let appName: String
    let letter: Character
    let icon: NSImage?
    @Environment(\.toastDismiss) private var dismiss
    @State private var visible = false

    var body: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            if let icon {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 24, height: 24)
            }
            Text("Pinned **\(appName)** to")
                .font(.system(size: 13))
            KeyCap(character: letter)
        }
        .padding(.horizontal, Theme.Metrics.grid * 2.5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(SurfaceBackground())
        .scaleEffect(visible ? 1 : 0.98)
        .opacity(visible ? 1 : 0)
        .animation(Theme.Motion.overlayIn, value: visible)
        .onAppear { visible = true }
        .onTapGesture { dismiss() }
    }
}
