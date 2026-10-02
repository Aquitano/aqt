import Foundation

package struct OutboxFile {
    package enum Restored {
        case events([WireEvent])
        case unreadable(any Error, movedTo: URL)
    }

    package let url: URL

    package init(url: URL) {
        self.url = url
    }

    package static func defaultURL(deviceID: UUID) -> URL {
        URL.applicationSupportDirectory
            .appending(path: "tracker/outbox", directoryHint: .isDirectory)
            .appending(path: "\(deviceID.uuidString.lowercased()).json")
    }

    package func load() -> Result<[WireEvent], any Error> {
        Result {
            do {
                return try JSONDecoder().decode([WireEvent].self, from: Data(contentsOf: url))
            } catch CocoaError.fileReadNoSuchFile {
                return []
            }
        }
    }

    /// An unreadable file is moved aside, so the fresh queue that replaces it
    /// persists without overwriting the events it may still hold. A move onto
    /// an earlier copy fails instead.
    package func restore(at now: Date = .now) -> Result<Restored, any Error> {
        switch load() {
        case let .success(events):
            return .success(.events(events))
        case let .failure(error):
            let stamp = Date.ISO8601FormatStyle(dateSeparator: .omitted, timeSeparator: .omitted).format(now)
            let name = url.deletingPathExtension().lastPathComponent
            let destination = url.deletingLastPathComponent().appending(path: "\(name).unreadable-\(stamp).json")
            return Result {
                try FileManager.default.moveItem(at: url, to: destination)
                return .unreadable(error, movedTo: destination)
            }
        }
    }

    package func save(_ events: [WireEvent]) -> Result<Void, any Error> {
        Result {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
            )
            let data = try JSONEncoder().encode(events)
            let temporary = directory.appending(path: ".outbox-\(UUID().uuidString).json")
            guard FileManager.default.createFile(
                atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]
            ) else {
                throw CocoaError(.fileWriteUnknown)
            }
            defer { try? FileManager.default.removeItem(at: temporary) }
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: url)
            }
        }
    }
}
