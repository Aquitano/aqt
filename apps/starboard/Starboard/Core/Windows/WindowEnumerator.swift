import AppKit

/// A window as seen by CGWindowList. `title` is nil without the Screen
/// Recording permission — callers must render a fallback label.
struct WindowInfo: Equatable, Identifiable {
    let id: CGWindowID
    let pid: pid_t
    let appName: String
    let bundleID: String?
    let title: String?
    /// False for minimized windows and windows on other Spaces.
    let isOnScreen: Bool

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return "\(appName) Window"
    }
}

/// Lists windows front-to-back. One CGWindowList pass covers both audiences:
/// `visibleWindows()` is the Cmd-Tab-replacement filter (current Space, not
/// minimized, BATTLEPLAN §3.5), `allWindows()` is what search offers so a
/// minimized or other-Space window is still reachable by name.
enum WindowEnumerator {
    private struct Cache {
        let createdAt: ContinuousClock.Instant
        let windows: [WindowInfo]
    }

    private static let lock = NSLock()
    private static var cache: Cache?
    /// Long enough that priming at the start of a hold still pays off on the
    /// first Tab. Anything that reorders windows — Space changes, app
    /// activation, launches and quits — invalidates the cache outright.
    private static let cacheLifetime: Duration = .seconds(1)

    /// Windows of the current Space, minimized ones excluded.
    static func visibleWindows() -> [WindowInfo] {
        allWindows().filter(\.isOnScreen)
    }

    /// Every window of every regular app, including minimized and other Spaces.
    static func allWindows() -> [WindowInfo] {
        let now = ContinuousClock.now
        if let cached = lock.withLock({ cache }), now - cached.createdAt < cacheLifetime {
            return cached.windows
        }

        let interval = Perf.beginWindowEnumeration()
        defer { Perf.endWindowEnumeration(interval) }
        guard let list = CGWindowListCopyWindowInfo(
            [.optionAll, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else { return [] }

        let ownPID = ProcessInfo.processInfo.processIdentifier
        var appCache: [pid_t: NSRunningApplication?] = [:]

        let windows: [WindowInfo] = list.compactMap { entry in
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
                title: entry[kCGWindowName as String] as? String,
                isOnScreen: entry[kCGWindowIsOnscreen as String] as? Bool ?? false
            )
        }
        lock.withLock { cache = Cache(createdAt: now, windows: windows) }
        return windows
    }

    /// Fills the cache off the main thread so the first Tab of a hold reads it
    /// instead of blocking on CGWindowList.
    static func prime() {
        DispatchQueue.global(qos: .userInitiated).async { _ = allWindows() }
    }

    static func invalidateCache() {
        lock.withLock { cache = nil }
    }
}
