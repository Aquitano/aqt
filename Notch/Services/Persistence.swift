import Foundation

/// JSON persistence rooted at ~/Library/Application Support/Notch.
/// Small, synchronous, and only touched from background contexts for file I/O.
final class Persistence {

    let rootDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

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
        try? data.write(to: url, options: .atomic)
    }
}
