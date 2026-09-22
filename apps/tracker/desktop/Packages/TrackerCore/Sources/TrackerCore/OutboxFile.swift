import Foundation

package struct OutboxFile {
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
