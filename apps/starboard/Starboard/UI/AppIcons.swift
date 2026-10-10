import AppKit

/// App icons for the overlay and the Stage sheet, kept for the life of the
/// process, misses included. NSWorkspace hands out icons that decode on first
/// draw, which costs 5 to 40 ms on the main thread in the middle of a
/// keystroke, so `preload` renders them in the background first.
@MainActor
enum AppIcons {
    private static var icons: [String: NSImage?] = [:]
    private static var pending: Set<String> = []
    private static let size = NSSize(width: 24, height: 24)

    static func icon(for bundleID: String) -> NSImage? {
        if let cached = icons[bundleID] {
            return cached
        }
        let icon = render(bundleID).map { NSImage(cgImage: $0, size: size) }
        icons[bundleID] = .some(icon)
        return icon
    }

    static func preload(_ bundleIDs: [String]) {
        let missing = Set(bundleIDs).subtracting(icons.keys).subtracting(pending)
        guard !missing.isEmpty else { return }
        pending.formUnion(missing)
        Task {
            let rendered = await Task.detached(priority: .utility) {
                missing.map { bundleID in (bundleID, render(bundleID)) }
            }.value
            for (bundleID, image) in rendered where icons[bundleID] == nil {
                icons[bundleID] = .some(image.map { NSImage(cgImage: $0, size: size) })
            }
            pending.subtract(missing)
        }
    }

    /// Rendered at twice the display size for Retina screens.
    private nonisolated static func render(_ bundleID: String) -> CGImage? {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return nil }
        var rect = NSRect(x: 0, y: 0, width: 48, height: 48)
        return NSWorkspace.shared.icon(forFile: url.path).cgImage(forProposedRect: &rect, context: nil, hints: nil)
    }
}
