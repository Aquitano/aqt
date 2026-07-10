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

    /// Where the system-wide adapter ended up, for the Settings UI — the toggle
    /// alone can't show that the adapter was requested but silently fell back.
    enum AdapterState: Equatable {
        case notRequested
        case starting
        case active
        /// Artifacts found nowhere (bundle or Application Support): Settings
        /// offers the guided install instead of a bare error.
        case missing
        case unavailable(String)
    }
    @Published private(set) var adapterState: AdapterState = .notRequested

    /// Wall-clock of the last snapshot, so views can interpolate the seek bar.
    private(set) var lastUpdate = Date()

    private let activities: ActivityManager
    private let imageCache: ImageCache
    private let settings: Settings

    private var controller: MediaControlling?
    private var renderingActive = true
    private var cancellables = Set<AnyCancellable>()

    init(activities: ActivityManager, imageCache: ImageCache, settings: Settings) {
        self.activities = activities
        self.imageCache = imageCache
        self.settings = settings
    }

    func start() {
        settings.$showCompactNowPlaying
            .removeDuplicates()
            .sink { [weak self] enabled in
                guard let self else { return }
                self.activities.setNowPlaying(active: enabled && !self.track.isEmpty)
            }
            .store(in: &cancellables)

        // Start on the always-available scripting controller so launch never blocks
        // on the adapter's synchronous perl probe (hundreds of ms). If the adapter is
        // enabled and its probe passes off-main, upgrade to it in place.
        let controller: MediaControlling = ScriptingMediaController()
        wire(controller)
        controller.start()
        self.controller = controller
        self.capabilities = controller.capabilities
        Log.media.info("Media controller: \(String(describing: type(of: controller)))")

        if settings.enableMediaAdapter {
            guard let adapter = AdapterMediaController() else {
                adapterState = .missing
                return
            }
            adapterState = .starting
            Task.detached(priority: .userInitiated) {
                let probe = adapter.probe()
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    switch probe {
                    case .available:
                        self.upgradeToAdapter(adapter)
                    case .unavailable(let reason):
                        self.adapterState = .unavailable("\(reason) Using per-app control instead.")
                        Log.media.notice("mediaremote-adapter self-test failed; staying on scripting")
                    }
                }
            }
        }
    }

    private func upgradeToAdapter(_ adapter: AdapterMediaController) {
        controller?.stop()
        wire(adapter)
        controller = adapter
        capabilities = adapter.capabilities
        adapter.start()
        // start() may synchronously report a launch failure and install the
        // scripting fallback. Do not overwrite that failure state with active.
        guard controller === adapter else { return }
        adapterState = .active
        Log.media.info("Media controller upgraded to system-wide adapter")
    }

    private func wire(_ controller: MediaControlling) {
        controller.onUpdate = { [weak self] track in self?.apply(track) }
        controller.onArtwork = { [weak self] data in self?.applyArtwork(data) }
        if let adapter = controller as? AdapterMediaController {
            adapter.onStreamEnded = { [weak self] in self?.fallBackToScripting() }
        }
    }

    /// The adapter's perl bridge died; swap in per-app scripting so playback control
    /// keeps working instead of freezing on the last track forever.
    private func fallBackToScripting() {
        guard controller is AdapterMediaController else { return }
        controller?.stop()
        let scripting = ScriptingMediaController()
        wire(scripting)
        scripting.start()
        controller = scripting
        capabilities = scripting.capabilities
        adapterState = .unavailable("The adapter stopped; using per-app control instead.")
        Log.media.notice("Media adapter stream died; fell back to scripting")
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

    // MARK: - State updates

    private func apply(_ newTrack: NowPlayingTrack) {
        let identityChanged = newTrack.identity != track.identity
        track = newTrack
        lastUpdate = Date()
        isAvailable = true
        activities.setNowPlaying(active: settings.showCompactNowPlaying && !newTrack.isEmpty)
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
