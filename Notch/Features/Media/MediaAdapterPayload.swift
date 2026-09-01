import Foundation

/// Newline frame emitted by the pinned mediaremote-adapter bridge.
struct MediaAdapterEnvelope: Decodable {
    let type: String
    let payload: MediaAdapterPayload?
}

/// The bridge reports media times in microseconds. Keeping the wire model
/// separate makes protocol drift testable without launching the private bridge.
struct MediaAdapterPayload: Decodable {
    let title: String?
    let artist: String?
    let album: String?
    let isPlaying: Bool?
    let durationMicros: Double?
    let elapsedTimeMicros: Double?
    let applicationName: String?
    let bundleIdentifier: String?
    let artworkDataBase64: String?
    let timestampEpochMicros: Double?
    let playbackRate: Double?

    var artworkData: Data? {
        artworkDataBase64.flatMap { Data(base64Encoded: $0) }
    }

    func track(at date: Date = Date()) -> NowPlayingTrack {
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
