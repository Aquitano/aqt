import Foundation
import AppKit

/// A snapshot of what's playing system-wide. Value type so it can cross actors
/// freely; the decoded artwork lives in `NowPlayingArtwork` keyed by a stable id.
struct NowPlayingTrack: Equatable {
    var title: String
    var artist: String
    var album: String
    var duration: TimeInterval        // seconds; 0 if unknown
    var elapsed: TimeInterval         // seconds at `timestamp`
    var isPlaying: Bool
    var bundleIdentifier: String?     // the source app, when known
    var appName: String?

    /// Stable identity for the track so we only redecode artwork on real changes.
    var identity: String { "\(title)\u{1F}\(artist)\u{1F}\(album)" }

    static let empty = NowPlayingTrack(
        title: "", artist: "", album: "",
        duration: 0, elapsed: 0, isPlaying: false,
        bundleIdentifier: nil, appName: nil
    )

    var isEmpty: Bool { title.isEmpty && artist.isEmpty }

    /// Interpolated playback position given a wall-clock reference.
    func position(asOf reference: Date, lastUpdate: Date) -> TimeInterval {
        guard isPlaying, duration > 0 else { return min(elapsed, duration) }
        let drift = reference.timeIntervalSince(lastUpdate)
        return min(max(0, elapsed + drift), duration)
    }
}

/// Commands a media controller must be able to issue. A controller advertises
/// which it actually supports via `capabilities` so the UI can hide what it
/// can't drive (e.g. a seek bar when the adapter can't seek).
enum MediaCommand: Equatable {
    case playPause
    case next
    case previous
    case seek(TimeInterval)
    case toggleShuffle
    case toggleRepeat
}

struct MediaCapabilities: OptionSet {
    let rawValue: Int
    static let transport = MediaCapabilities(rawValue: 1 << 0)   // play/pause/next/prev
    static let seek      = MediaCapabilities(rawValue: 1 << 1)
    static let shuffle   = MediaCapabilities(rawValue: 1 << 2)
    static let repeatMode = MediaCapabilities(rawValue: 1 << 3)
    static let artwork   = MediaCapabilities(rawValue: 1 << 4)

    static let full: MediaCapabilities = [.transport, .seek, .shuffle, .repeatMode, .artwork]
}
