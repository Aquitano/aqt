import AppKit
import NotchCore

/// Per-app Now Playing via AppleScript for Music and Spotify. Push-driven by
/// each app's DistributedNotification (no polling). Scripts run on a background
/// queue; results are delivered on the main actor.
@MainActor
final class ScriptingMediaController: MediaControlling {

    var onUpdate: ((NowPlayingTrack) -> Void)?
    var onArtwork: ((Data?) -> Void)?
    let capabilities: MediaCapabilities = .full

    private let dnc = DistributedNotificationCenter.default()
    private var observers: [NSObjectProtocol] = []
    private let queue = DispatchQueue(label: "com.aquitano.notch.applescript")
    private let session = URLSession(configuration: .ephemeral)

    private var activeApp: MediaApp = .music
    private var lastArtworkIdentity = ""
    private var artworkRequestIdentity: String?
    private var currentTrackIdentity = ""

    func start() {
        for app in MediaApp.allCases {
            let token = dnc.addObserver(forName: app.notificationName, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.refresh(preferred: app) }
            }
            observers.append(token)
        }
        refresh(preferred: nil)
    }

    func stop() {
        observers.forEach { dnc.removeObserver($0) }
        observers.removeAll()
    }

    func send(_ command: MediaCommand) {
        guard let script = command.appleScript(for: activeApp) else { return }
        let app = activeApp
        queue.async { [weak self] in
            _ = AppleScript.run(script)
            let track = Self.readTrack(app: app)
            Task { @MainActor in
                guard let self else { return }
                if let track { self.deliver(track, from: app) }
            }
        }
    }

    // MARK: - Refresh

    private func refresh(preferred: MediaApp?) {
        let order: [MediaApp] = preferred.map { pref in [pref] + MediaApp.allCases.filter { $0 != pref } } ?? MediaApp.allCases
        queue.async { [weak self] in
            let candidates = order.compactMap { app -> (MediaApp, NowPlayingTrack)? in
                guard app.isRunning, let track = Self.readTrack(app: app) else { return nil }
                return (app, track)
            }
            // A playing source always wins over a paused one. Within the same state,
            // the app whose notification triggered this refresh stays preferred.
            let selected = candidates.first(where: { $0.1.isPlaying }) ?? candidates.first
            Task { @MainActor in
                guard let self else { return }
                if let (app, track) = selected {
                    self.deliver(track, from: app)
                } else {
                    self.currentTrackIdentity = ""
                    self.artworkRequestIdentity = nil
                    self.lastArtworkIdentity = ""
                    self.onUpdate?(.empty)
                    self.onArtwork?(nil)
                }
            }
        }
    }

    /// Reads one app off-main and returns its current non-stopped track.
    nonisolated private static func readTrack(app: MediaApp) -> NowPlayingTrack? {
        guard app.isRunning, let descriptor = AppleScript.run(app.readScript) else { return nil }
        let raw = descriptor.stringValue ?? ""
        return MediaApp.parse(raw, app: app)
    }

    private func deliver(_ track: NowPlayingTrack, from app: MediaApp) {
        activeApp = app
        currentTrackIdentity = track.identity
        onUpdate?(track)
        fetchArtwork(for: track, app: app)
    }

    // MARK: - Artwork

    private func fetchArtwork(for track: NowPlayingTrack, app: MediaApp) {
        let identity = track.identity
        guard identity != lastArtworkIdentity,
              identity != artworkRequestIdentity else { return }
        artworkRequestIdentity = identity
        // Never display the prior track's art while a new request is in flight.
        onArtwork?(nil)

        switch app {
        case .spotify:
            queue.async { [weak self] in
                let urlString = AppleScript.run(app.artworkURLScript)?.stringValue
                Task { @MainActor in
                    guard let self else { return }
                    guard let urlString, let url = URL(string: urlString) else {
                        self.completeArtwork(nil, identity: identity)
                        return
                    }
                    await self.downloadArtwork(from: url, identity: identity)
                }
            }
        case .music:
            queue.async { [weak self] in
                let data = AppleScript.run(app.artworkDataScript)?.data
                Task { @MainActor in self?.completeArtwork(data, identity: identity) }
            }
        }
    }

    private func downloadArtwork(from url: URL, identity: String) async {
        let data = try? await session.data(from: url).0
        completeArtwork(data, identity: identity)
    }

    private func completeArtwork(_ data: Data?, identity: String) {
        guard artworkRequestIdentity == identity else { return }
        artworkRequestIdentity = nil
        guard currentTrackIdentity == identity else { return }
        if data != nil { lastArtworkIdentity = identity }
        onArtwork?(data)
    }
}

// MARK: - App-specific scripting

enum MediaApp: CaseIterable {
    case music, spotify

    var bundleID: String { self == .music ? "com.apple.Music" : "com.spotify.client" }
    var notificationName: Notification.Name {
        Notification.Name(self == .music ? "com.apple.Music.playerInfo" : "com.spotify.client.PlaybackStateChanged")
    }
    private var appName: String { self == .music ? "Music" : "Spotify" }

    var isRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }

    /// Reads state with a unit-separator delimiter; never launches the app.
    var readScript: String {
        let durationExpr = self == .spotify ? "((duration of t) / 1000)" : "(duration of t)"
        return """
        tell application "\(appName)"
        try
        set ps to (player state as text)
        if ps is "stopped" then return "stopped"
        set t to current track
        set nm to (name of t)
        set ar to (artist of t)
        set al to (album of t)
        set du to \(durationExpr)
        set po to (player position)
        return ps & "\u{1F}" & nm & "\u{1F}" & ar & "\u{1F}" & al & "\u{1F}" & du & "\u{1F}" & po
        on error
        return "stopped"
        end try
        end tell
        """
    }

    var artworkURLScript: String {
        """
        tell application "Spotify"
        try
        return (artwork url of current track) as text
        on error
        return ""
        end try
        end tell
        """
    }

    var artworkDataScript: String {
        """
        tell application "Music"
        try
        return (data of artwork 1 of current track)
        end try
        end tell
        """
    }

    static func parse(_ raw: String, app: MediaApp) -> NowPlayingTrack? {
        if raw == "stopped" || raw.isEmpty { return nil }
        let parts = raw.components(separatedBy: "\u{1F}")
        guard parts.count >= 6 else { return nil }
        let state = parts[0]
        let track = NowPlayingTrack(
            title: parts[1],
            artist: parts[2],
            album: parts[3],
            duration: TimeInterval(parts[4].replacingOccurrences(of: ",", with: ".")) ?? 0,
            elapsed: TimeInterval(parts[5].replacingOccurrences(of: ",", with: ".")) ?? 0,
            isPlaying: state == "playing",
            bundleIdentifier: app.bundleID,
            appName: app == .music ? "Music" : "Spotify"
        )
        return track
    }
}

private extension MediaCommand {
    func appleScript(for app: MediaApp) -> String? {
        let name = app == .music ? "Music" : "Spotify"
        let body: String
        switch self {
        case .playPause: body = "playpause"
        case .next: body = "next track"
        case .previous: body = "previous track"
        case let .seek(position): body = "set player position to \(Int(position))"
        case .toggleShuffle:
            body = app == .music ? "set shuffle enabled to not (shuffle enabled)" : "set shuffling to not shuffling"
        case .toggleRepeat:
            if app == .music {
                // Music's `song repeat` is off/one/all, not a boolean. Unconditionally
                // setting it to `one` meant the key could never turn repeat off again
                // or reach `all`; cycle it so it behaves like a toggle (matching how
                // Spotify's boolean repeat already toggles).
                return """
                tell application "Music"
                    if song repeat is off then
                        set song repeat to one
                    else if song repeat is one then
                        set song repeat to all
                    else
                        set song repeat to off
                    end if
                end tell
                """
            }
            body = "set repeating to not repeating"
        }
        return "tell application \"\(name)\" to \(body)"
    }
}

/// Thin wrapper so script execution lives off the main thread.
enum AppleScript {
    static func run(_ source: String) -> NSAppleEventDescriptor? {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return nil }
        let result = script.executeAndReturnError(&error)
        if let error {
            Log.media.debug("AppleScript error: \(error)")
            return nil
        }
        return result
    }
}
