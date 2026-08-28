import AppKit

/// The one icon lookup path in the UI. LaunchServices resolution
/// (`urlForApplication` + `icon(forFile:)`) is slow enough to be felt when a
/// search row re-renders on every keystroke, so results are cached for the
/// process lifetime — misses included, so a missing app isn't looked up again.
@MainActor
enum AppIcons {
    private static var cache: [String: NSImage?] = [:]

    static func icon(for bundleID: String) -> NSImage? {
        if let cached = cache[bundleID] { return cached }
        let icon = lookup(bundleID)
        cache[bundleID] = icon
        return icon
    }

    private static func lookup(_ bundleID: String) -> NSImage? {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        if let icon = running.first?.icon { return icon }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}
