import Foundation

/// JSON persistence rooted at ~/Library/Application Support/Notch.
/// Small JSON persistence layer. Encoding happens at the call site; writes are
/// serialized off-main so adding/removing tray items never stalls SwiftUI layout.
final class Persistence: @unchecked Sendable {

    let rootDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let writeQueue = DispatchQueue(label: "com.aquitano.notch.persistence", qos: .utility)

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        rootDirectory = base.appendingPathComponent("Notch", isDirectory: true)
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
        let url = rootDirectory.appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(type, from: data)
    }

    func save<T: Encodable>(_ value: T, to fileName: String) {
        let url = rootDirectory.appendingPathComponent(fileName)
        guard let data = try? encoder.encode(value) else { return }
        writeQueue.async {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Drain pending writes during orderly app termination so the last note or
    /// tray mutation cannot be lost merely because disk I/O is asynchronous.
    func flush() {
        writeQueue.sync {}
    }
}
