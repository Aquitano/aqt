import Foundation

enum PersistenceError: Error, LocalizedError {
    case read(file: String, underlying: any Error)
    case decode(file: String, underlying: any Error)
    case encode(file: String, underlying: any Error)
    case write(file: String, underlying: any Error)
    case remove(file: String, underlying: any Error)

    var errorDescription: String? {
        switch self {
        case let .read(file, error): "Couldn't read \(file): \(error.localizedDescription)"
        case let .decode(file, error): "Couldn't decode \(file): \(error.localizedDescription)"
        case let .encode(file, error): "Couldn't encode \(file): \(error.localizedDescription)"
        case let .write(file, error): "Couldn't write \(file): \(error.localizedDescription)"
        case let .remove(file, error): "Couldn't remove \(file): \(error.localizedDescription)"
        }
    }
}

/// JSON persistence rooted at ~/Library/Application Support/Notch. Reads and
/// synchronous writes throw; the fire-and-forget `save` runs off-main so adding
/// or removing tray items never stalls layout, and hands its failures to
/// `onFailure` (Diagnostics in the app, nothing in tests).
final class Persistence: @unchecked Sendable {

    let rootDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let onFailure: @Sendable (PersistenceError) -> Void
    private let writeQueue = DispatchQueue(label: "com.aquitano.notch.persistence", qos: .utility)

    init(rootDirectory override: URL? = nil, onFailure: @escaping @Sendable (PersistenceError) -> Void = { _ in }) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        rootDirectory = override ?? base.appendingPathComponent("Notch", isDirectory: true)
        self.onFailure = onFailure
        try? FileManager.default.createDirectory(at: rootDirectory, withIntermediateDirectories: true)

        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    /// Resolve (and create) a subdirectory under the root.
    func directory(named name: String) -> URL {
        let url = rootDirectory.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// nil when the file does not exist; throws when it exists but is unreadable
    /// or does not decode.
    func load<T: Decodable>(_ type: T.Type, from fileName: String) throws(PersistenceError) -> T? {
        guard let data = try loadData(from: fileName) else { return nil }
        return try decode(type, from: data, file: fileName)
    }

    /// nil when the file does not exist.
    func loadData(from fileName: String) throws(PersistenceError) -> Data? {
        let url = rootDirectory.appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw .read(file: fileName, underlying: error)
        }
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data, file: String) throws(PersistenceError) -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw .decode(file: file, underlying: error)
        }
    }

    /// Encodes now, writes off-main, and reports a failed write to `onFailure`.
    func save<T: Encodable>(_ value: T, to fileName: String) {
        let url = rootDirectory.appendingPathComponent(fileName)
        let data: Data
        do {
            data = try encoder.encode(value)
        } catch {
            onFailure(.encode(file: fileName, underlying: error))
            return
        }
        writeQueue.async { [onFailure] in
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                onFailure(.write(file: fileName, underlying: error))
            }
        }
    }

    /// Migration commits are synchronous so the backup can never be mistaken for
    /// the authoritative store on a fast relaunch.
    func saveSynchronously<T: Encodable>(_ value: T, to fileName: String) throws(PersistenceError) {
        let url = rootDirectory.appendingPathComponent(fileName)
        let data: Data
        do {
            data = try encoder.encode(value)
        } catch {
            throw .encode(file: fileName, underlying: error)
        }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw .write(file: fileName, underlying: error)
        }
    }

    func writeBackupIfMissing(_ data: Data, to fileName: String) throws(PersistenceError) {
        let url = rootDirectory.appendingPathComponent(fileName)
        if FileManager.default.fileExists(atPath: url.path) { return }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw .write(file: fileName, underlying: error)
        }
    }

    /// A missing file is not a failure; anything else is reported.
    func removeFile(named fileName: String) {
        let url = rootDirectory.appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            onFailure(.remove(file: fileName, underlying: error))
        }
    }

    /// Drain pending writes during orderly app termination so the last note or
    /// tray mutation cannot be lost merely because disk I/O is asynchronous.
    func flush() {
        writeQueue.sync {}
    }
}
