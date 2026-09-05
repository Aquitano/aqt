import AppKit

/// Strategy B (BATTLEPLAN §3.6): private SkyLight (CGS) APIs for animation-free
/// Space switching, window moving, and current-Space queries.
///
/// Every symbol is resolved at runtime with dlsym — init fails (and the app
/// falls back to SyntheticSpaceSwitcher) on any macOS where one is missing.
/// Nothing outside this file may touch SkyLight.
final class DirectSpaceSwitcher {
    private typealias MainConnectionFn = @convention(c) () -> UInt32
    private typealias CopySpacesFn = @convention(c) (UInt32) -> Unmanaged<CFArray>?
    private typealias SetSpaceFn = @convention(c) (UInt32, CFString, UInt64) -> Void
    private typealias MoveWindowsFn = @convention(c) (UInt32, CFArray, UInt64) -> Void

    private let connection: UInt32
    private let copySpaces: CopySpacesFn
    private let setSpace: SetSpaceFn
    private let moveWindows: MoveWindowsFn?

    init?() {
        guard let handle = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY
        ),
            let mainConnection = dlsym(handle, "SLSMainConnectionID"),
            let copy = dlsym(handle, "SLSCopyManagedDisplaySpaces"),
            let set = dlsym(handle, "SLSManagedDisplaySetCurrentSpace")
        else { return nil }

        connection = unsafeBitCast(mainConnection, to: MainConnectionFn.self)()
        copySpaces = unsafeBitCast(copy, to: CopySpacesFn.self)
        setSpace = unsafeBitCast(set, to: SetSpaceFn.self)
        moveWindows = dlsym(handle, "SLSMoveWindowsToManagedSpace")
            .map { unsafeBitCast($0, to: MoveWindowsFn.self) }
    }

    var canMoveWindows: Bool {
        moveWindows != nil
    }

    /// 1-based index of the active Space among the active display's user Spaces.
    var currentSpaceIndex: Int? {
        guard let display = activeDisplay(),
              let current = (display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int64
        else { return nil }
        return userSpaceIDs(of: display).firstIndex(of: UInt64(current)).map { $0 + 1 }
    }

    func jump(to index: Int) {
        guard let display = activeDisplay(),
              let identifier = display["Display Identifier"] as? String else { return }
        let spaces = userSpaceIDs(of: display)
        guard spaces.indices.contains(index - 1) else { return }
        setSpace(connection, identifier as CFString, spaces[index - 1])
    }

    func jumpAdjacent(_ direction: SpaceDirection) {
        guard let current = currentSpaceIndex else { return }
        jump(to: direction == .left ? current - 1 : current + 1)
    }

    /// Moves one window (by CGWindowID) to the Space at 1-based `index`.
    func move(windowID: CGWindowID, toSpace index: Int) {
        guard let moveWindows,
              let display = activeDisplay() else { return }
        let spaces = userSpaceIDs(of: display)
        guard spaces.indices.contains(index - 1) else { return }
        moveWindows(connection, [NSNumber(value: windowID)] as CFArray, spaces[index - 1])
    }

    // MARK: - Managed display parsing

    /// The managed display the pointer is on — the one Mission Control acts on
    /// when "Displays have separate Spaces" is enabled. SkyLight identifies
    /// displays by their CoreGraphics UUID string, but not on every macOS (a
    /// single-display setup reports "Main"), so an unmatched pointer falls back
    /// to the first display.
    private func activeDisplay() -> [String: Any]? {
        guard let array = copySpaces(connection)?.takeRetainedValue() as? [[String: Any]] else {
            return nil
        }
        guard array.count > 1, let uuid = pointerDisplayUUID() else { return array.first }
        return array.first { ($0["Display Identifier"] as? String) == uuid } ?? array.first
    }

    /// CoreGraphics rather than NSScreen/NSEvent: `move(windowID:toSpace:)` is
    /// called off the main thread.
    private func pointerDisplayUUID() -> String? {
        guard let location = CGEvent(source: nil)?.location else { return nil }
        var displayID = CGDirectDisplayID(0)
        var count: UInt32 = 0
        guard CGGetDisplaysWithPoint(location, 1, &displayID, &count) == .success, count == 1,
              let uuid = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue()
        else { return nil }
        return CFUUIDCreateString(nil, uuid) as String
    }

    /// User Spaces only (type 0) — fullscreen app Spaces are not numbered.
    private func userSpaceIDs(of display: [String: Any]) -> [UInt64] {
        guard let spaces = display["Spaces"] as? [[String: Any]] else { return [] }
        return spaces.compactMap { space in
            guard (space["type"] as? Int ?? 0) == 0,
                  let id = space["ManagedSpaceID"] as? Int64 else { return nil }
            return UInt64(id)
        }
    }
}
