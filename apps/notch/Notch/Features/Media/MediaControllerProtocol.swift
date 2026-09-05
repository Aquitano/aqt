import Foundation
import NotchCore

/// A source of Now Playing data + transport control. The `MediaManager` picks a
/// concrete controller at runtime (system-wide adapter when available, else
/// per-app scripting) and treats them uniformly through this protocol.
@MainActor
protocol MediaControlling: AnyObject {
    /// Push a fresh track snapshot (called on the main actor).
    var onUpdate: ((NowPlayingTrack) -> Void)? { get set }
    /// Push raw artwork bytes for the current track, or nil to clear.
    var onArtwork: ((Data?) -> Void)? { get set }

    var capabilities: MediaCapabilities { get }

    /// Begin listening. Implementations must be push-based (no polling timers).
    func start()
    func stop()

    func send(_ command: MediaCommand)
}
