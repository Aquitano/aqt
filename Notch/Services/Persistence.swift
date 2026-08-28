import Foundation

/// JSON persistence rooted at ~/Library/Application Support/Notch.
/// Small JSON persistence layer. Encoding happens at the call site; writes are
/// serialized off-main so adding/removing tray items never stalls SwiftUI layout.
final class Persistence: @unchecked Sendable {

    let rootDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let writeQueue = DispatchQueue(label: "com.aquitano.notch.persistence", qos: .utility)

    init(rootDirectory override: URL? = nil) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        rootDirectory = override ?? base.appendingPathComponent("Notch", isDirectory: true)
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

    func load<T: Decodable>(_ type: T.Type, from fileName: String) -> T? {
        guard let data = loadData(from: fileName) else { return nil }
        return decode(type, from: data)
    }

    func loadData(from fileName: String) -> Data? {
        try? Data(contentsOf: rootDirectory.appendingPathComponent(fileName))
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
        try? decoder.decode(type, from: data)
    }

    func save<T: Encodable>(_ value: T, to fileName: String) {
        let url = rootDirectory.appendingPathComponent(fileName)
        guard let data = try? encoder.encode(value) else { return }
        writeQueue.async {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Migration commits are synchronous so the backup can never be mistaken for
    /// the authoritative store on a fast relaunch.
    func saveSynchronously<T: Encodable>(_ value: T, to fileName: String) -> Bool {
        let url = rootDirectory.appendingPathComponent(fileName)
        guard let data = try? encoder.encode(value) else { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    func writeBackupIfMissing(_ data: Data, to fileName: String) -> Bool {
        let url = rootDirectory.appendingPathComponent(fileName)
        if FileManager.default.fileExists(atPath: url.path) { return true }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    func removeFile(named fileName: String) {
        try? FileManager.default.removeItem(
            at: rootDirectory.appendingPathComponent(fileName)
        )
    }

    /// Drain pending writes during orderly app termination so the last note or
    /// tray mutation cannot be lost merely because disk I/O is asynchronous.
    func flush() {
        writeQueue.sync {}
    }
}
