import Foundation

/// Newline frame emitted by the pinned mediaremote-adapter bridge.
package struct MediaAdapterEnvelope: Decodable {
    package let type: String
    package let payload: MediaAdapterPayload?
}

/// The bridge reports media times in microseconds. Keeping the wire model
/// separate makes protocol drift testable without launching the private bridge.
package struct MediaAdapterPayload: Decodable {
    package let title: String?
    package let artist: String?
    package let album: String?
    package let isPlaying: Bool?
    package let durationMicros: Double?
    package let elapsedTimeMicros: Double?
    package let applicationName: String?
    package let bundleIdentifier: String?
    package let artworkDataBase64: String?
    package let timestampEpochMicros: Double?
    package let playbackRate: Double?

    package var artworkData: Data? {
        artworkDataBase64.flatMap { Data(base64Encoded: $0) }
    }

    package func track(at date: Date = Date()) -> NowPlayingTrack {
        let playing = isPlaying ?? false
        var elapsed = max(0, (elapsedTimeMicros ?? 0) / 1_000_000)
        if playing,
           let timestampEpochMicros,
           let playbackRate,
           playbackRate > 0 {
            let timestamp = timestampEpochMicros / 1_000_000
            elapsed += max(0, date.timeIntervalSince1970 - timestamp) * playbackRate
        }
        return NowPlayingTrack(
            title: title ?? "",
            artist: artist ?? "",
            album: album ?? "",
            duration: max(0, (durationMicros ?? 0) / 1_000_000),
            elapsed: elapsed,
            isPlaying: playing,
            bundleIdentifier: bundleIdentifier,
            appName: applicationName
        )
    }
}
