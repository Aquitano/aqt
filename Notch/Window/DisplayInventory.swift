import AppKit
import CoreGraphics

/// Converts the current AppKit display topology into stable, value-only
/// descriptors. Recreate on every screen-parameter notification; never retain
/// `NSScreen` identity across topology changes.
enum DisplayInventory {
    static func current() -> [DisplayDescriptor] {
        NSScreen.screens.compactMap(descriptor(for:))
    }

    static func fallback() -> DisplayDescriptor {
        let screen = NSScreen.main ?? NSScreen.screens.first ?? NSScreen()
        return descriptor(for: screen) ?? DisplayDescriptor(
            key: "fallback-main",
            displayID: 0,
            name: "Main Display",
            frame: screen.frame,
            safeAreaTop: screen.safeAreaInsets.top,
            auxiliaryLeftWidth: screen.auxiliaryTopLeftArea?.width,
            auxiliaryRightWidth: screen.auxiliaryTopRightArea?.width,
            isBuiltIn: false,
            isMain: true
        )
    }

    private static func descriptor(for screen: NSScreen) -> DisplayDescriptor? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let number = screen.deviceDescription[key] as? NSNumber else { return nil }
        let displayID = CGDirectDisplayID(number.uint32Value)
        let builtIn = CGDisplayIsBuiltin(displayID) != 0
        let name = screen.localizedName
        return DisplayDescriptor(
            key: DisplayDescriptor.stableKey(
                unitNumber: CGDisplayUnitNumber(displayID),
                vendor: CGDisplayVendorNumber(displayID),
                model: CGDisplayModelNumber(displayID),
                serial: CGDisplaySerialNumber(displayID),
                name: name,
                isBuiltIn: builtIn
            ),
            displayID: displayID,
            name: name,
            frame: screen.frame,
            safeAreaTop: screen.safeAreaInsets.top,
            auxiliaryLeftWidth: screen.auxiliaryTopLeftArea?.width,
            auxiliaryRightWidth: screen.auxiliaryTopRightArea?.width,
            isBuiltIn: builtIn,
            isMain: CGDisplayIsMain(displayID) != 0
        )
    }
}
