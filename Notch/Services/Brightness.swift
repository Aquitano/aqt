import CoreGraphics
import Foundation

/// Reads built-in display brightness via the private DisplayServices framework.
/// dlopen + a declared symbol so there's no link dependency; degrades to nil if
/// Apple ever moves the symbol (isolated here per the risk register).
final class Brightness {

    private typealias GetBrightness = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32

    private let handle: UnsafeMutableRawPointer?
    private let getBrightness: GetBrightness?

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
    }

    var isAvailable: Bool { getBrightness != nil }

    /// Current brightness 0...1 for the main display, or nil if unreadable.
    func current() -> Float? {
        guard let getBrightness else { return nil }
        var value: Float = 0
        let result = getBrightness(CGMainDisplayID(), &value)
        return result == 0 ? value : nil
    }
}
