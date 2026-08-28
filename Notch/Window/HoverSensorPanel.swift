import AppKit

/// Invisible hover target that sits one level below a `NotchPanel`, covering only
/// the compact pill's hit rect. While the notch panel ignores mouse events (so
/// the rest of its frame stays click-through), the window server hands pointer
/// events over the pill to this panel instead, and `onEnter` turns the notch
/// panel interactive. This replaces a global mouse-moved monitor: AppKit now only
/// wakes the app when the pointer actually reaches the pill, not on every move.
/// Once the notch panel is interactive it covers this one and takes over.
@MainActor
final class HoverSensorPanel: NSPanel {

    var onEnter: (() -> Void)?

    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 2)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        isMovable = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        animationBehavior = .none
        ignoresMouseEvents = false
        acceptsMouseMovedEvents = true

        let view = SensorView()
        view.onEnter = { [weak self] in self?.onEnter?() }
        contentView = view
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Position the sensor over `rect` (screen coordinates) or take it off-screen.
    func update(rect: NSRect?) {
        guard let rect, !rect.isEmpty else {
            if isVisible { orderOut(nil) }
            return
        }
        if frame != rect { setFrame(rect, display: false) }
        if !isVisible { orderFrontRegardless() }
    }
}

private final class SensorView: NSView {
    var onEnter: (() -> Void)?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) { onEnter?() }
    // A pointer already resting on the pill when the sensor appears gets no
    // enter event, only moves; treat any of them as an entry.
    override func mouseMoved(with event: NSEvent) { onEnter?() }
    override func mouseDown(with event: NSEvent) { onEnter?() }
    override func scrollWheel(with event: NSEvent) { onEnter?() }
}
