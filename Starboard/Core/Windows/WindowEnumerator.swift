import AppKit

/// A window as seen by CGWindowList. `title` is nil without the Screen
/// Recording permission — callers must render a fallback label.
struct WindowInfo: Equatable, Identifiable {
    let id: CGWindowID
    let pid: pid_t
    let appName: String
    let bundleID: String?
    let title: String?

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return "\(appName) Window"
    }
}

/// Lists the current Space's visible windows front-to-back. On-screen-only
/// enumeration inherently excludes minimized windows and other Spaces — exactly
/// the Cmd-Tab-replacement filter (BATTLEPLAN §3.5).
enum WindowEnumerator {
    static func visibleWindows() -> [WindowInfo] {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else { return [] }

        let ownPID = ProcessInfo.processInfo.processIdentifier
        var appCache: [pid_t: NSRunningApplication?] = [:]

        return list.compactMap { entry in
            guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
                  let windowNumber = entry[kCGWindowNumber as String] as? Int,
                  let ownerPID = entry[kCGWindowOwnerPID as String] as? Int,
                  ownerPID != ownPID else { return nil }

            // Skip tiny utility surfaces (status items, tooltips).
            if let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat],
               (bounds["Width"] ?? 0) < 64 || (bounds["Height"] ?? 0) < 64 {
                return nil
            }

            let pid = pid_t(ownerPID)
            let app = appCache[pid, default: NSRunningApplication(processIdentifier: pid)]
            appCache[pid] = app
            guard let app, app.activationPolicy == .regular else { return nil }

            return WindowInfo(
                id: CGWindowID(windowNumber),
                pid: pid,
                appName: app.localizedName
                    ?? entry[kCGWindowOwnerName as String] as? String
                    ?? "App",
                bundleID: app.bundleIdentifier,
                title: entry[kCGWindowName as String] as? String
            )
        }
    }
}
