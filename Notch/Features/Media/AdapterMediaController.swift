import Darwin
import NotchCore
import Foundation

/// System-wide Now Playing via the pinned `mediaremote-adapter` Perl bridge.
///
/// The package framework is embedded and signed but deliberately not linked.
/// `/usr/bin/perl` loads its executable at runtime, so mediaremoted sees the
/// platform Perl process rather than this unentitled app.
@MainActor
final class AdapterMediaController: MediaControlling {

    enum ProbeResult: Sendable, Equatable {
        case available
        case unavailable(String)
    }

    var onUpdate: ((NowPlayingTrack) -> Void)?
    var onArtwork: ((Data?) -> Void)?
    var onStreamEnded: (() -> Void)?
    let capabilities: MediaCapabilities = .full

    private enum Command {
        static let probe = "get"
        static let stream = "loop"
        static let playPause = "toggle_play_pause"
        static let next = "next_track"
        static let previous = "previous_track"
        static let seek = "set_time"
        static let shuffle = "toggle_shuffle"
        static let repeatMode = "toggle_repeat"
    }

    nonisolated private static let perlPath = "/usr/bin/perl"
    private let scriptPath: String
    private let frameworkExecutablePath: String

    private var streamProcess: Process?
    private var streamInput: Pipe?
    private var streamOutput: Pipe?
    private let decoder = JSONDecoder()
    private var buffer = Data()
    private var lastArtworkIdentity = ""
    private var lastArtworkByteCount = 0
    private var streamEnded = false

    init?() {
        guard FileManager.default.isExecutableFile(atPath: Self.perlPath),
              let artifacts = Self.locateBundledArtifacts() else { return nil }
        scriptPath = artifacts.script.path
        frameworkExecutablePath = artifacts.frameworkExecutable.path
    }

    private struct Artifacts {
        let script: URL
        let frameworkExecutable: URL
    }

    nonisolated private static func locateBundledArtifacts() -> Artifacts? {
        guard let script = Bundle.main.url(
            forResource: "mediaremote-adapter",
            withExtension: "pl"
        ), let frameworks = Bundle.main.privateFrameworksURL else { return nil }

        let framework = frameworks.appendingPathComponent(
            "MediaRemoteAdapter.framework",
            isDirectory: true
        )
        let candidates = [
            framework.appendingPathComponent("Versions/A/MediaRemoteAdapter"),
            framework.appendingPathComponent("MediaRemoteAdapter"),
        ]
        guard let executable = candidates.first(where: {
            FileManager.default.isExecutableFile(atPath: $0.path)
        }) else { return nil }
        return Artifacts(script: script, frameworkExecutable: executable)
    }

    /// `get` is both a capability test and an ABI/protocol test. A healthy bridge
    /// must exit successfully and emit either `NIL` or a decodable data frame.
    nonisolated func probe() -> ProbeResult {
        let result = Self.runOneShot(
            arguments: [scriptPath, frameworkExecutablePath, Command.probe],
            timeout: 5
        )
        if result.timedOut {
            return .unavailable("The bundled adapter self-test timed out.")
        }
        guard result.status == 0 else {
            let detail = result.stderr
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\n", with: " ")
                .prefix(240)
            let suffix = detail.isEmpty ? "" : " \(detail)"
            return .unavailable("The bundled adapter exited with status \(result.status).\(suffix)")
        }
        for line in result.stdout.split(whereSeparator: { $0.isNewline }) {
            if line == "NIL" { return .available }
            guard let data = String(line).data(using: .utf8),
                  let envelope = try? JSONDecoder().decode(MediaAdapterEnvelope.self, from: data),
                  envelope.type == "data",
                  envelope.payload != nil else { continue }
            return .available
        }
        return .unavailable("The bundled adapter returned no valid self-test response.")
    }

    func start() {
        guard streamProcess == nil else { return }
        streamEnded = false
        buffer.removeAll(keepingCapacity: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: Self.perlPath)
        process.arguments = [scriptPath, frameworkExecutablePath, Command.stream]

        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                Task { @MainActor in self?.streamDidEnd() }
                return
            }
            Task { @MainActor in self?.ingest(chunk) }
        }
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.streamDidEnd() }
        }

        do {
            try process.run()
            streamProcess = process
            streamInput = input
            streamOutput = output
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            Log.media.error("Failed to start adapter stream: \(error.localizedDescription)")
            streamDidEnd()
        }
    }

    func stop() {
        streamEnded = true
        streamOutput?.fileHandleForReading.readabilityHandler = nil
        try? streamInput?.fileHandleForWriting.close()
        streamProcess?.terminate()
        streamProcess = nil
        streamInput = nil
        streamOutput = nil
        buffer.removeAll(keepingCapacity: false)
    }

    private func streamDidEnd() {
        guard !streamEnded else { return }
        streamEnded = true
        let process = streamProcess
        streamOutput?.fileHandleForReading.readabilityHandler = nil
        try? streamInput?.fileHandleForWriting.close()
        streamProcess = nil
        streamInput = nil
        streamOutput = nil
        buffer.removeAll(keepingCapacity: false)
        if process?.isRunning == true { process?.terminate() }
        Log.media.notice("mediaremote-adapter stream ended; falling back")
        onStreamEnded?()
    }

    func send(_ command: MediaCommand) {
        let arguments: [String]
        switch command {
        case .playPause: arguments = [Command.playPause]
        case .next: arguments = [Command.next]
        case .previous: arguments = [Command.previous]
        case let .seek(position): arguments = [Command.seek, String(position)]
        case .toggleShuffle: arguments = [Command.shuffle]
        case .toggleRepeat: arguments = [Command.repeatMode]
        }

        let line = arguments.joined(separator: " ") + "\n"
        if let process = streamProcess,
           process.isRunning,
           let data = line.data(using: .utf8),
           let handle = streamInput?.fileHandleForWriting {
            do {
                try handle.write(contentsOf: data)
                return
            } catch {
                Log.media.notice("Adapter command pipe closed; using one-shot command")
            }
        }

        let oneShot = [scriptPath, frameworkExecutablePath] + arguments
        Task.detached(priority: .userInitiated) {
            _ = Self.runOneShot(arguments: oneShot, timeout: 3)
        }
    }

    // MARK: - Stream parsing

    private func ingest(_ chunk: Data) {
        buffer.append(chunk)
        let newline = UInt8(ascii: "\n")
        while let index = buffer.firstIndex(of: newline) {
            let line = buffer.subdata(in: buffer.startIndex..<index)
            buffer.removeSubrange(buffer.startIndex...index)
            guard !line.isEmpty else { continue }
            decodeLine(line)
        }
        // Artwork frames can be large, but an unterminated or malicious stream
        // must not grow memory forever.
        if buffer.count > 16 * 1024 * 1024 {
            Log.media.error("Adapter emitted an oversized unterminated frame")
            buffer.removeAll(keepingCapacity: false)
        }
    }

    private func decodeLine(_ data: Data) {
        if data == Data("NIL".utf8) {
            lastArtworkIdentity = ""
            lastArtworkByteCount = 0
            onUpdate?(.empty)
            onArtwork?(nil)
            return
        }
        guard let envelope = try? decoder.decode(MediaAdapterEnvelope.self, from: data),
              envelope.type == "data",
              let payload = envelope.payload else {
            Log.media.error("Adapter emitted an invalid protocol frame")
            return
        }

        let track = payload.track()
        let artwork = payload.artworkData
        onUpdate?(track)

        if track.identity != lastArtworkIdentity {
            lastArtworkIdentity = track.identity
            lastArtworkByteCount = artwork?.count ?? 0
            onArtwork?(artwork)
        } else if let artwork, artwork.count > lastArtworkByteCount {
            // MediaRemote sometimes follows a full-size image with a thumbnail.
            // Upgrade artwork for the same track, but never downgrade it.
            lastArtworkByteCount = artwork.count
            onArtwork?(artwork)
        }
    }

    // MARK: - Bounded process execution

    private struct ProcessResult: Sendable {
        let status: Int32
        let stdout: String
        let stderr: String
        let timedOut: Bool
    }

    nonisolated private static func runOneShot(
        arguments: [String],
        timeout: TimeInterval
    ) -> ProcessResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: perlPath)
        process.arguments = arguments

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let stdout = LockedData()
        let stderr = LockedData()
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .utility).async {
            stdout.set(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global(qos: .utility).async {
            stderr.set(stderrPipe.fileHandleForReading.readDataToEndOfFile())
            readers.leave()
        }

        do {
            try process.run()
        } catch {
            try? stdoutPipe.fileHandleForWriting.close()
            try? stderrPipe.fileHandleForWriting.close()
            _ = readers.wait(timeout: .now() + 1)
            return ProcessResult(
                status: -1, stdout: "", stderr: error.localizedDescription, timedOut: false
            )
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline { usleep(20_000) }
        let timedOut = process.isRunning
        if timedOut {
            process.terminate()
            let killDeadline = Date().addingTimeInterval(0.5)
            while process.isRunning, Date() < killDeadline { usleep(20_000) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        process.waitUntilExit()
        _ = readers.wait(timeout: .now() + 1)
        return ProcessResult(
            status: process.terminationStatus,
            stdout: String(data: stdout.value, encoding: .utf8) ?? "",
            stderr: String(data: stderr.value, encoding: .utf8) ?? "",
            timedOut: timedOut
        )
    }
}

private final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    func set(_ data: Data) {
        lock.lock()
        storage = data
        lock.unlock()
    }

    var value: Data {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
