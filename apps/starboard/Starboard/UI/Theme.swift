import SwiftUI

/// Colors, sizes and motion shared by the overlay, the toasts and the windows.
enum Theme {
    enum Colors {
        static let accent = Color(red: 1.00, green: 0.478, blue: 0.349) // #FF7A59
        static let surface = Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 0.118, green: 0.122, blue: 0.133, alpha: 1)
                : NSColor(red: 0.96, green: 0.96, blue: 0.97, alpha: 1)
        })
        static let stroke = Color.primary.opacity(0.10)
        static let selection = Color.primary.opacity(0.08)
        static let hover = Color.primary.opacity(0.04)
        static let tag = Color.primary.opacity(0.08)
        static let tagContrast = Color.primary.opacity(0.16)
    }

    enum Metrics {
        static let grid: CGFloat = 8
        static let panelRadius: CGFloat = 16
        static let rowRadius: CGFloat = 8
        static let rowHeight: CGFloat = 40
        static let rowIcon: CGFloat = 24
        static let tagSize: CGFloat = 28
        static let searchWidth: CGFloat = 760
        static let searchHeader: CGFloat = 64
        static let searchFooter: CGFloat = 52
        static let searchRows = 8
    }

    enum Motion {
        /// Only toasts animate. A fade behind a keystroke reads as lag, so the
        /// overlay and its selection change instantly.
        static let toastIn = Animation.easeOut(duration: 0.16)
    }
}

/// A floating panel that never takes key focus, so the frontmost app keeps
/// receiving input while it is on screen.
final class HudPanel: NSPanel {
    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    }

    override var canBecomeKey: Bool {
        false
    }

    /// The visible frame of the screen under the pointer. The pointer tracks
    /// where the user is looking better than `NSScreen.main` does.
    static var pointerScreenFrame: NSRect {
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main
        return screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }
}

/// The dark blurred surface behind the overlay and the toasts.
struct SurfaceBackground: View {
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let increased = contrast == .increased
        VisualEffectSurface()
            .overlay {
                Rectangle().fill(Color.black.opacity(increased ? 0.85 : 0.72))
            }
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Metrics.panelRadius)
                    .strokeBorder(Color.primary.opacity(increased ? 0.28 : 0.10), lineWidth: increased ? 1.5 : 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.panelRadius))
    }

    private struct VisualEffectSurface: NSViewRepresentable {
        func makeNSView(context _: Context) -> NSVisualEffectView {
            let view = NSVisualEffectView()
            view.material = .hudWindow
            view.blendingMode = .behindWindow
            view.state = .active
            return view
        }

        func updateNSView(_: NSVisualEffectView, context _: Context) {}
    }
}

/// A key name in a rounded square, as Raycast shows list accessories.
struct KeyTag: View {
    let label: String
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        Text(label)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .frame(minWidth: Theme.Metrics.tagSize, minHeight: Theme.Metrics.tagSize)
            .background(
                RoundedRectangle(cornerRadius: Theme.Metrics.rowRadius)
                    .fill(contrast == .increased ? Theme.Colors.tagContrast : Theme.Colors.tag)
            )
    }
}

/// Shows `content` in a titleless window in front of everything. Starboard
/// has no Dock icon, so it activates itself first.
@MainActor
func showWindow(_ content: some View, size: NSSize) -> NSWindow {
    let window = NSWindow(
        contentRect: NSRect(origin: .zero, size: size),
        styleMask: [.titled, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: content)
    window.center()
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
    return window
}
