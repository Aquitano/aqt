import SwiftUI

/// Base class for nonactivating overlay panels: never takes key focus, floats
/// above everything, positioned relative to the screen under the pointer.
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

    /// HUDs belong on the screen the user is looking at, which the pointer
    /// tracks better than `NSScreen.main` does. `visibleFrame` keeps them clear
    /// of the menu bar and the Dock.
    static var mainScreenBounds: NSRect {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        return screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }
}

/// NSVisualEffectView wrapper per BATTLEPLAN §4: hudWindow material, dark tint,
/// inner stroke, panel radius.
struct SurfaceBackground: View {
    var cornerRadius: CGFloat = Theme.Metrics.panelRadius
    @Environment(\.themeContrastBoost) private var contrastBoost

    var body: some View {
        VisualEffectSurface()
            .overlay {
                // Near-opaque like Raycast's window; the blur only softens
                // what little shows through.
                Rectangle()
                    .fill(Color.black.opacity(contrastBoost ? 0.85 : 0.72))
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(
                        Color.primary.opacity(contrastBoost ? 0.28 : 0.10),
                        lineWidth: contrastBoost ? 1.5 : 1
                    )
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

/// Key tag for shortcut letters (BATTLEPLAN §4 type spec): a rounded square
/// the way Raycast renders list accessories.
struct KeyCap: View {
    let character: Character

    var body: some View {
        KeyTag(label: String(character).uppercased())
    }
}

struct KeyTag: View {
    let label: String
    @Environment(\.themeContrastBoost) private var contrastBoost

    var body: some View {
        Text(label)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .frame(minWidth: Theme.Metrics.tagSize, minHeight: Theme.Metrics.tagSize)
            .background(
                RoundedRectangle(cornerRadius: Theme.Metrics.rowRadius)
                    .fill(contrastBoost ? Theme.Colors.tagContrast : Theme.Colors.tag)
            )
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
                .themeAccessibility()
        )
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.setFrame(placementFrame(width: 360, height: 52), display: true)

        // The content view animates itself in; a panel fade on top of it would
        // be a second, slower fade over the same moment.
        panel.alphaValue = 1
        panel.orderFrontRegardless()

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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false

    var body: some View {
        Text(message)
            .font(.system(size: 13))
            .lineLimit(1)
            .padding(.horizontal, Theme.Metrics.grid * 2.5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(SurfaceBackground())
            .scaleEffect(reduceMotion || visible ? 1 : 0.98)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
        .scaleEffect(reduceMotion || visible ? 1 : 0.98)
        .opacity(visible ? 1 : 0)
        .animation(Theme.Motion.overlayIn, value: visible)
        .onAppear { visible = true }
        .onTapGesture { dismiss() }
    }
}
