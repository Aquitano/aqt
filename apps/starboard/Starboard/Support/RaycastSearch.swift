import AppKit

/// Opens the Raycast command that mirrors the hold overlay. Raycast is only
/// the display: it polls the overlay state over the socket and closes itself
/// when the hold ends, so the keyboard semantics stay the tap's.
@MainActor
final class RaycastSearch {
    private let deeplink: URL
    private var shown = false

    init(deeplink: URL) {
        self.deeplink = deeplink
    }

    func present() {
        guard !shown else { return }
        shown = true
        // The synchronous variant blocks the caller for ~70 ms, and the caller
        // is the main run loop that also services the event tap.
        NSWorkspace.shared.open(deeplink, configuration: .init()) { _, _ in }
    }

    func dismiss() {
        shown = false
    }
}
