import CoreGraphics
import Foundation

/// Reads and writes built-in display brightness via the private DisplayServices
/// framework. dlopen + declared symbols so there's no link dependency; degrades
/// to nil if Apple ever moves a symbol (isolated here per the risk register).
final class Brightness {

    private typealias GetBrightness = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
    private typealias SetBrightness = @convention(c) (UInt32, Float) -> Int32

    private let handle: UnsafeMutableRawPointer?
    private let getBrightness: GetBrightness?
    private let setBrightness: SetBrightness?

    init() {
        handle = dlopen(
            "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices",
            RTLD_NOW
        )
        if let handle, let symbol = dlsym(handle, "DisplayServicesGetBrightness") {
            getBrightness = unsafeBitCast(symbol, to: GetBrightness.self)
        } else {
            getBrightness = nil
            Log.hud.error("DisplayServicesGetBrightness unavailable")
        }
        if let handle, let symbol = dlsym(handle, "DisplayServicesSetBrightness") {
            setBrightness = unsafeBitCast(symbol, to: SetBrightness.self)
        } else {
            setBrightness = nil
            Log.hud.error("DisplayServicesSetBrightness unavailable")
        }
    }

    var isAvailable: Bool { getBrightness != nil }

    /// Current brightness 0...1 for the main display, or nil if unreadable.
    func current() -> Float? {
        guard let getBrightness else { return nil }
        var value: Float = 0
        let result = getBrightness(CGMainDisplayID(), &value)
        return result == 0 ? value : nil
    }

    /// Step the main display's brightness and return the read-back level, or
    /// nil when the display can't be driven (external panel, missing symbol) —
    /// callers must not swallow the media key then.
    func applyStep(_ delta: Float) -> Float? {
        guard let setBrightness, let value = current() else { return nil }
        let target = min(max(value + delta, 0), 1)
        guard setBrightness(CGMainDisplayID(), target) == 0 else { return nil }
        return current() ?? target
    }
}
