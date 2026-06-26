import AppKit

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

    func start() {
        for app in MediaApp.allCases {
            let token = dnc.addObserver(forName: app.notificationName, object: nil, queue: .main) { [weak self] _ in
                self?.refresh(preferred: app)
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
            self?.read(app: app)
        }
    }

    // MARK: - Refresh

    private func refresh(preferred: MediaApp?) {
        let order: [MediaApp] = preferred.map { pref in [pref] + MediaApp.allCases.filter { $0 != pref } } ?? MediaApp.allCases
        queue.async { [weak self] in
            guard let self else { return }
            for app in order where app.isRunning {
                if self.read(app: app) { return }
            }
            DispatchQueue.main.async { [weak self] in
                self?.onUpdate?(.empty)
            }
        }
    }

    /// Reads one app; returns true if it produced a non-stopped track.
    @discardableResult
    private func read(app: MediaApp) -> Bool {
        guard app.isRunning, let descriptor = AppleScript.run(app.readScript) else { return false }
        let raw = descriptor.stringValue ?? ""
        guard let track = MediaApp.parse(raw, app: app) else { return false }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.activeApp = app
            self.onUpdate?(track)
            self.fetchArtwork(for: track, app: app)
        }
        return true
    }

    // MARK: - Artwork

    private func fetchArtwork(for track: NowPlayingTrack, app: MediaApp) {
        guard track.identity != lastArtworkIdentity else { return }
        lastArtworkIdentity = track.identity

        switch app {
        case .spotify:
            queue.async { [weak self] in
                guard let self,
                      let urlString = AppleScript.run(app.artworkURLScript)?.stringValue,
                      let url = URL(string: urlString) else { return }
                Task { [weak self] in
                    let data = try? await self?.session.data(from: url).0
                    await MainActor.run { self?.onArtwork?(data) }
                }
            }
        case .music:
            queue.async { [weak self] in
                let data = AppleScript.run(app.artworkDataScript)?.data
                DispatchQueue.main.async { self?.onArtwork?(data) }
            }
        }
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
            body = app == .music ? "set song repeat to one" : "set repeating to not repeating"
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
