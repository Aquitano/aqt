import Foundation

/// A snapshot of what's playing system-wide. Value type so it can cross actors
/// freely; the decoded artwork lives in `NowPlayingArtwork` keyed by a stable id.
package struct NowPlayingTrack: Equatable {
    package var title: String
    package var artist: String
    package var album: String
    package var duration: TimeInterval // seconds; 0 if unknown
    package var elapsed: TimeInterval // seconds at `timestamp`
    package var isPlaying: Bool
    package var bundleIdentifier: String? // the source app, when known
    package var appName: String?

    package init(
        title: String,
        artist: String,
        album: String,
        duration: TimeInterval,
        elapsed: TimeInterval,
        isPlaying: Bool,
        bundleIdentifier: String? = nil,
        appName: String? = nil
    ) {
        self.title = title
        self.artist = artist
        self.album = album
        self.duration = duration
        self.elapsed = elapsed
        self.isPlaying = isPlaying
        self.bundleIdentifier = bundleIdentifier
        self.appName = appName
    }

    /// Stable identity for the track so we only redecode artwork on real changes.
    package var identity: String {
        "\(title)\u{1F}\(artist)\u{1F}\(album)"
    }

    package static let empty = NowPlayingTrack(
        title: "", artist: "", album: "",
        duration: 0, elapsed: 0, isPlaying: false,
        bundleIdentifier: nil, appName: nil
    )

    package var isEmpty: Bool {
        title.isEmpty && artist.isEmpty
    }

    /// Interpolated playback position given a wall-clock reference.
    package func position(asOf reference: Date, lastUpdate: Date) -> TimeInterval {
        let base = isPlaying ? elapsed + reference.timeIntervalSince(lastUpdate) : elapsed
        let floored = max(0, base)
        // duration == 0 means "unknown" (live streams, some adapters). Clamping to
        // it would discard the elapsed signal exactly when it's all we have, so only
        // cap at duration when it's actually known.
        return duration > 0 ? min(floored, duration) : floored
    }
}

/// Commands a media controller must be able to issue. A controller advertises
/// which it actually supports via `capabilities` so the UI can hide what it
/// can't drive (e.g. a seek bar when the adapter can't seek).
package enum MediaCommand: Equatable {
    case playPause
    case next
    case previous
    case seek(TimeInterval)
    case toggleShuffle
    case toggleRepeat
}

package struct MediaCapabilities: OptionSet {
    package let rawValue: Int
    package init(rawValue: Int) {
        self.rawValue = rawValue
    }

    package static let transport = MediaCapabilities(rawValue: 1 << 0) // play/pause/next/prev
    package static let seek = MediaCapabilities(rawValue: 1 << 1)
    package static let shuffle = MediaCapabilities(rawValue: 1 << 2)
    package static let repeatMode = MediaCapabilities(rawValue: 1 << 3)
    package static let artwork = MediaCapabilities(rawValue: 1 << 4)

    package static let full: MediaCapabilities = [.transport, .seek, .shuffle, .repeatMode, .artwork]
}
