import AppKit

/// The one icon and display-name lookup path in the UI. LaunchServices
/// resolution (`urlForApplication` + `icon(forFile:)` / `Bundle`) is slow
/// enough to be felt when a search row re-renders on every keystroke, so
/// results are cached for the process lifetime — misses included, so a missing
/// app isn't looked up again.
@MainActor
enum AppIcons {
    private static var icons: [String: NSImage?] = [:]
    private static var names: [String: String?] = [:]
    private static var paths: [String: String?] = [:]

    static func icon(for bundleID: String) -> NSImage? {
        if let cached = icons[bundleID] { return cached }
        let icon = lookupIcon(bundleID)
        icons[bundleID] = icon
        return icon
    }

    /// Localized app name, nil when the app isn't installed.
    static func name(for bundleID: String) -> String? {
        if let cached = names[bundleID] { return cached }
        let name = lookupName(bundleID)
        names[bundleID] = name
        return name
    }

    /// Bundle path, nil when the app isn't installed. Raycast renders icons
    /// from paths, and the mirror asks for every row on every poll.
    static func path(for bundleID: String) -> String? {
        if let cached = paths[bundleID] { return cached }
        let path = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)?.path
        paths[bundleID] = path
        return path
    }

    private static func lookupIcon(_ bundleID: String) -> NSImage? {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        if let icon = running.first?.icon { return icon }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: url.path)
    }

    private static func lookupName(_ bundleID: String) -> String? {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        if let name = running.first?.localizedName { return name }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
              let bundle = Bundle(url: url) else { return nil }
        return bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
            ?? url.deletingPathExtension().lastPathComponent
    }
}
