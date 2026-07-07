import Foundation

/// System-wide Now Playing via the `mediaremote-adapter` perl bridge.
///
/// `/usr/bin/perl` is a platform binary (bundle id `com.apple.perl`), so a
/// process it hosts passes `mediaremoted`'s entitlement check that unentitled
/// apps fail since macOS 15.4. We spawn:
///
///     /usr/bin/perl <Resources>/mediaremote-adapter.pl <Frameworks>/MediaRemoteAdapter.framework stream
///
/// and read newline-delimited JSON. `init?` returns nil (→ scripting fallback)
/// unless both artifacts are bundled and the one-shot `test` command exits 0.
///
/// To enable: bundle `mediaremote-adapter.pl` (Resources) and a signed,
/// **not-linked** `MediaRemoteAdapter.framework` (Contents/Frameworks). See README.
final class AdapterMediaController: MediaControlling {

    var onUpdate: ((NowPlayingTrack) -> Void)?
    var onArtwork: ((Data?) -> Void)?
    /// Fired once if the perl bridge exits or crashes, so the owner can fall back.
    var onStreamEnded: (() -> Void)?
    let capabilities: MediaCapabilities = .full

    /// The adapter's write-side sub-commands, which are fork-sensitive (reads come
    /// from the JSON `stream` this app parses itself). A fork with different names
    /// is a one-place edit here.
    private enum Command {
        static let test = "test"
        static let stream = "stream"
        static let send = "send"
        static let playPause = "playpause"
        static let next = "next"
        static let previous = "previous"
        static let seek = "seek"
        static let shuffle = "shuffle"
        static let repeatMode = "repeat"
    }

    private static let perlPath = "/usr/bin/perl"
    private let scriptPath: String
    private let frameworkPath: String

    private var streamProcess: Process?
    private let decoder = JSONDecoder()
    private var buffer = Data()
    private var lastArtworkIdentity = ""
    private var streamEnded = false

    init?() {
        guard FileManager.default.fileExists(atPath: Self.perlPath),
              let artifacts = Self.locateArtifacts()
        else { return nil }

        self.scriptPath = artifacts.script.path
        self.frameworkPath = artifacts.framework.path
    }

    /// Where Settings' guided setup drops a user-installed adapter. Checked before
    /// the bundle so it works on builds without the artifacts and can override a
    /// bundled copy without rebuilding the app.
    static var externalDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Notch/adapter", isDirectory: true)
    }

    /// Both artifacts exist at the external location.
    static var externalInstallPresent: Bool {
        let dir = externalDirectory
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent(scriptName).path)
            && FileManager.default.fileExists(atPath: dir.appendingPathComponent(frameworkName).path)
    }

    private static let scriptName = "mediaremote-adapter.pl"
    private static let frameworkName = "MediaRemoteAdapter.framework"

    private static func locateArtifacts() -> (script: URL, framework: URL)? {
        if externalInstallPresent {
            let dir = externalDirectory
            return (dir.appendingPathComponent(scriptName), dir.appendingPathComponent(frameworkName))
        }
        guard let script = Bundle.main.url(forResource: "mediaremote-adapter", withExtension: "pl"),
              let framework = Bundle.main.privateFrameworksURL?
                .appendingPathComponent(frameworkName),
              FileManager.default.fileExists(atPath: framework.path)
        else { return nil }
        return (script, framework)
    }

    /// The one-shot `test`: spawns perl and waits, which can take hundreds of ms, so
    /// it must run off the main thread. `nonisolated` and reads only immutable paths.
    nonisolated func probe() -> Bool {
        Self.runOneShot(arguments: [scriptPath, frameworkPath, Command.test]) == 0
    }

    func start() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: Self.perlPath)
        process.arguments = [scriptPath, frameworkPath, Command.stream]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            // An empty read is EOF: the bridge exited. The fd stays readable-at-EOF
            // and would re-invoke us forever (a spinning queue at high CPU), so clear
            // the handler and recover.
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                Task { @MainActor in self?.streamDidEnd() }
                return
            }
            self?.ingest(chunk)
        }

        // Backstop for the case where the process dies without the pipe reaching EOF.
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.streamDidEnd() }
        }

        do {
            try process.run()
            streamProcess = process
        } catch {
            Log.media.error("Failed to start adapter stream: \(error.localizedDescription)")
        }
    }

    func stop() {
        streamEnded = true
        streamProcess?.terminate()
        streamProcess = nil
    }

    /// Fire the fallback exactly once. `stop()` marks the stream ended first, so an
    /// intentional teardown doesn't masquerade as a crash.
    private func streamDidEnd() {
        guard !streamEnded else { return }
        streamEnded = true
        streamProcess = nil
        Log.media.notice("mediaremote-adapter stream ended; falling back")
        onStreamEnded?()
    }

    func send(_ command: MediaCommand) {
        let args: [String]
        switch command {
        case .playPause: args = [scriptPath, frameworkPath, Command.send, Command.playPause]
        case .next: args = [scriptPath, frameworkPath, Command.send, Command.next]
        case .previous: args = [scriptPath, frameworkPath, Command.send, Command.previous]
        case let .seek(position): args = [scriptPath, frameworkPath, Command.seek, String(Int(position))]
        case .toggleShuffle: args = [scriptPath, frameworkPath, Command.shuffle]
        case .toggleRepeat: args = [scriptPath, frameworkPath, Command.repeatMode]
        }
        DispatchQueue.global(qos: .userInitiated).async {
            _ = Self.runOneShot(arguments: args)
        }
    }

    // MARK: - Stream parsing

    private func ingest(_ chunk: Data) {
        buffer.append(chunk)
        let newline = UInt8(ascii: "\n")
        while let index = buffer.firstIndex(of: newline) {
            let lineData = buffer.subdata(in: buffer.startIndex..<index)
            buffer.removeSubrange(buffer.startIndex...index)
            guard !lineData.isEmpty else { continue }
            decodeLine(lineData)
        }
    }

    private func decodeLine(_ data: Data) {
        guard let payload = try? decoder.decode(AdapterPayload.self, from: data) else { return }
        let track = payload.track
        let artworkData = payload.artworkData.flatMap { Data(base64Encoded: $0) }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.onUpdate?(track)
            if track.identity != self.lastArtworkIdentity {
                self.lastArtworkIdentity = track.identity
                self.onArtwork?(artworkData)
            }
        }
    }

    @discardableResult
    nonisolated private static func runOneShot(arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: perlPath)
        process.arguments = arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }
}

/// Maps the adapter's JSON line to our model. Keys are optional so a partial
/// frame never drops the whole update.
private struct AdapterPayload: Decodable {
    var title: String?
    var artist: String?
    var album: String?
    var duration: Double?
    var elapsedTime: Double?
    var playing: Bool?
    var bundleIdentifier: String?
    var artworkData: String?

    enum CodingKeys: String, CodingKey {
        case title, artist, album, duration
        case elapsedTime = "elapsedTime"
        case playing
        case bundleIdentifier = "bundleIdentifier"
        case artworkData = "artworkData"
    }

    var track: NowPlayingTrack {
        NowPlayingTrack(
            title: title ?? "",
            artist: artist ?? "",
            album: album ?? "",
            duration: duration ?? 0,
            elapsed: elapsedTime ?? 0,
            isPlaying: playing ?? false,
            bundleIdentifier: bundleIdentifier,
            appName: nil
        )
    }
}
