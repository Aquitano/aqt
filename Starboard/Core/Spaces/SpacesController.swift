import AppKit

/// Chooses between the two Space-switching strategies per the user's setting,
/// auto-falling back to synthetic when the private APIs are unavailable
/// (BATTLEPLAN §3.6). Main actor.
@MainActor
final class SpacesController {
    private let settings: SettingsStore
    private let direct = DirectSpaceSwitcher()

    init(settings: SettingsStore) {
        self.settings = settings
    }

    /// True when the private-API strategy is both chosen and available.
    var usesDirect: Bool {
        settings.model.spacesStrategy == .direct && direct != nil
    }

    var canMoveWindows: Bool {
        usesDirect && direct?.canMoveWindows == true
    }

    /// 1-based active Space number, only knowable via the direct strategy.
    var currentSpaceNumber: Int? {
        usesDirect ? direct?.currentSpaceIndex : nil
    }

    func jump(to index: Int) {
        if usesDirect, let direct {
            direct.jump(to: index)
        } else {
            SyntheticSpaceSwitcher.jump(to: index)
        }
    }

    func jumpAdjacent(_ direction: SpaceDirection) {
        if usesDirect, let direct {
            direct.jumpAdjacent(direction)
        } else {
            SyntheticSpaceSwitcher.jumpAdjacent(direction)
        }
    }

    /// ralt+digit: move the focused window to a Space. Direct strategy only —
    /// the router doesn't emit the intent otherwise.
    func moveFocusedWindow(to index: Int) {
        guard canMoveWindows, let direct,
              let app = NSWorkspace.shared.frontmostApplication else { return }
        let pid = app.processIdentifier
        DispatchQueue.global(qos: .userInitiated).async {
            let appElement = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(appElement, 0.25)
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(
                appElement, kAXFocusedWindowAttribute as CFString, &value
            ) == .success, let focused = value,
                CFGetTypeID(focused) == AXUIElementGetTypeID() else { return }
            // Swift has no checked cast for CoreFoundation types; the type ID
            // guard above is the check.
            let element = unsafeDowncast(focused, to: AXUIElement.self)
            var windowID = CGWindowID(0)
            guard _AXUIElementGetWindow(element, &windowID) == .success else {
                return
            }
            direct.move(windowID: windowID, toSpace: index)
        }
    }
}
