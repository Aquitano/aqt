import SwiftUI
import Combine

/// Owns the active `MediaController`, publishes Now Playing state, and decodes
/// artwork off-main. Selects the system-wide adapter when available, otherwise
/// per-app scripting (Music / Spotify).
@MainActor
final class MediaManager: ObservableObject {

    @Published private(set) var track: NowPlayingTrack = .empty
    @Published private(set) var artwork: NSImage?
    @Published private(set) var capabilities: MediaCapabilities = []
    @Published private(set) var isAvailable = false

    /// Wall-clock of the last snapshot, so views can interpolate the seek bar.
    private(set) var lastUpdate = Date()

    private let activities: ActivityManager
    private let imageCache: ImageCache
    private let settings: Settings

    private var controller: MediaControlling?
    private var renderingActive = true

    init(activities: ActivityManager, imageCache: ImageCache, settings: Settings) {
        self.activities = activities
        self.imageCache = imageCache
        self.settings = settings
    }

    func start() {
        let controller = makeController()
        controller.onUpdate = { [weak self] track in self?.apply(track) }
        controller.onArtwork = { [weak self] data in self?.applyArtwork(data) }
        controller.start()
        self.controller = controller
        self.capabilities = controller.capabilities
        Log.media.info("Media controller: \(String(describing: type(of: controller)))")
    }

    func send(_ command: MediaCommand) {
        controller?.send(command)
    }

    func setRenderingActive(_ active: Bool) {
        renderingActive = active
    }

    var canSeek: Bool { capabilities.contains(.seek) }

    /// Interpolated playback position for the current instant.
    func position(asOf date: Date = Date()) -> TimeInterval {
        track.position(asOf: date, lastUpdate: lastUpdate)
    }

    // MARK: - Controller selection

    private func makeController() -> MediaControlling {
        // System-wide bridge when its artifacts are bundled and `test` passes;
        // otherwise per-app scripting. The adapter init returns nil when the
        // perl/framework artifacts aren't present, so this always degrades.
        if settings.enableMediaAdapter, let adapter = AdapterMediaController() {
            return adapter
        }
        return ScriptingMediaController()
    }

    // MARK: - State updates

    private func apply(_ newTrack: NowPlayingTrack) {
        let identityChanged = newTrack.identity != track.identity
        track = newTrack
        lastUpdate = Date()
        isAvailable = true
        activities.setNowPlaying(active: !newTrack.isEmpty)
        if newTrack.isEmpty || identityChanged {
            artwork = nil
        }
    }

    private func applyArtwork(_ data: Data?) {
        guard let data, !data.isEmpty else {
            artwork = nil
            return
        }
        let identity = track.identity
        let cache = imageCache
        Task.detached(priority: .utility) {
            let image = cache.makeArtwork(from: data, key: identity, maxDimension: 180)
            await MainActor.run { [weak self] in
                guard let self, self.track.identity == identity else { return }
                self.artwork = image
            }
        }
    }
}
