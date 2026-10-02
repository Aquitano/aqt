import Foundation

/// One JSON event per line, so an enqueue appends only its own events and a
/// damaged line costs that one event rather than the queue.
package struct OutboxFile {
    package struct Restored {
        package var events: [WireEvent] = []
        package var skippedLines = 0
        package var movedAside: [(url: URL, error: any Error)] = []
    }

    package let url: URL
    private let encoder = JSONEncoder()

    package init(url: URL) {
        self.url = url
    }

    package static func defaultURL(deviceID: UUID) -> URL {
        URL.applicationSupportDirectory
            .appending(path: "tracker/outbox", directoryHint: .isDirectory)
            .appending(path: "\(deviceID.uuidString.lowercased()).jsonl")
    }

    /// Where the queue was one JSON array, before it became lines.
    package var legacyURL: URL {
        url.deletingPathExtension().appendingPathExtension("json")
    }

    /// A file that cannot be read is moved aside, so the fresh queue that
    /// replaces it persists without overwriting the events it may still hold.
    /// A move onto an earlier copy fails instead.
    package func restore(at now: Date = .now) -> Result<Restored, any Error> {
        Result {
            var restored = Restored()
            do {
                if let data = try contents(of: legacyURL) {
                    restored.events = try JSONDecoder().decode([WireEvent].self, from: data)
                }
            } catch {
                try restored.movedAside.append((moveAside(legacyURL, at: now), error))
            }
            do {
                let decoder = JSONDecoder()
                for line in try contents(of: url)?.split(separator: Self.newline) ?? [] {
                    guard let event = try? decoder.decode(WireEvent.self, from: line) else {
                        restored.skippedLines += 1
                        continue
                    }
                    restored.events.append(event)
                }
            } catch {
                try restored.movedAside.append((moveAside(url, at: now), error))
            }
            return restored
        }
    }

    package func append(_ events: [WireEvent]) -> Result<Void, any Error> {
        Result {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: lines(events))
        }
    }

    /// The rename replaces the whole file at once, so a crash leaves one queue
    /// or the other. The legacy array goes only once a rewrite holds its
    /// events; a crash in between sends them twice, which the server ignores.
    package func save(_ events: [WireEvent]) -> Result<Void, any Error> {
        Result {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
            )
            let temporary = directory.appending(path: ".outbox-\(UUID().uuidString).jsonl")
            guard try FileManager.default.createFile(
                atPath: temporary.path, contents: lines(events), attributes: [.posixPermissions: 0o600]
            ) else {
                throw CocoaError(.fileWriteUnknown)
            }
            guard rename(temporary.path, url.path) == 0 else {
                let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                try? FileManager.default.removeItem(at: temporary)
                throw error
            }
            if FileManager.default.fileExists(atPath: legacyURL.path) {
                try FileManager.default.removeItem(at: legacyURL)
            }
        }
    }

    private static let newline = UInt8(ascii: "\n")

    private func lines(_ events: [WireEvent]) throws -> Data {
        var data = Data()
        for event in events {
            try data.append(encoder.encode(event))
            data.append(Self.newline)
        }
        return data
    }

    private func contents(of file: URL) throws -> Data? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try Data(contentsOf: file)
    }

    private func moveAside(_ file: URL, at now: Date) throws -> URL {
        let stamp = Date.ISO8601FormatStyle(dateSeparator: .omitted, timeSeparator: .omitted).format(now)
        let name = file.deletingPathExtension().lastPathComponent
        let destination = file.deletingLastPathComponent()
            .appending(path: "\(name).unreadable-\(stamp).\(file.pathExtension)")
        try FileManager.default.moveItem(at: file, to: destination)
        return destination
    }
}
