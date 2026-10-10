import Foundation
import Observation
import StarboardCore

/// The config file at ~/.config/starboard/config.json. Starboard reloads it
/// whenever it changes on disk. When an edit doesn't parse, the last good
/// config stays in effect and the error is kept until the file is fixed.
@MainActor
@Observable
final class ConfigStore {
    static let defaultURL = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".config/starboard/config.json")

    let url: URL
    private(set) var config = Config()
    private(set) var error: ConfigError?
    /// Called after the config or the error changed.
    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored private var watcher: FileWatcher?
    @ObservationIgnored private var pendingReload: Task<Void, Never>?

    init(url: URL = ConfigStore.defaultURL) {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            load()
        } else {
            // Every key, written out, is the documentation of what can be set.
            if case let .failure(failure) = write(config) {
                error = failure
            }
        }
        watcher = FileWatcher(url: url) { [weak self] in self?.scheduleReload() }
    }

    /// Applies `change` to the file as it is on disk now and writes it back.
    /// Refused while the file doesn't parse, so an edit in progress is never
    /// overwritten.
    func update(_ change: (inout Config) -> Void) -> Result<Void, ConfigError> {
        load()
        if let error {
            return .failure(error)
        }
        var next = config
        change(&next)
        guard next != config else { return .success(()) }
        return write(next).map {
            config = next
            onChange?()
        }
    }

    private func scheduleReload() {
        // Editors often write a file in several steps; read once they settle.
        pendingReload?.cancel()
        pendingReload = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(50))
            guard !Task.isCancelled else { return }
            self?.load()
        }
    }

    private func load() {
        let result: Result<Config, ConfigError>
        do {
            result = try Config.decode(Data(contentsOf: url))
        } catch {
            result = .failure(ConfigError(message: error.localizedDescription))
        }
        switch result {
        case let .success(loaded):
            guard loaded != config || error != nil else { return }
            config = loaded
            error = nil
        case let .failure(failure):
            guard failure != error else { return }
            error = failure
        }
        onChange?()
    }

    private func write(_ config: Config) -> Result<Void, ConfigError> {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try config.encoded().write(to: url, options: .atomic)
            return .success(())
        } catch {
            return .failure(ConfigError(message: "could not write \(url.path): \(error.localizedDescription)"))
        }
    }
}
