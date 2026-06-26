import AppKit

/// Borderless, clear, non-activating panel that floats just above the menu bar.
/// Passive overlay: it never steals focus except while presenting the AirDrop
/// share sheet, which must anchor to a key-capable window.
final class NotchPanel: NSPanel {

    /// Flipped true only for the duration of an AirDrop / share interaction.
    var presentingShareSheet = false

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]

        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        isMovable = false
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        hidesOnDeactivate = false
        animationBehavior = .none
    }

    override var canBecomeKey: Bool { presentingShareSheet }
    override var canBecomeMain: Bool { false }
    override var acceptsFirstResponder: Bool { presentingShareSheet }
}
