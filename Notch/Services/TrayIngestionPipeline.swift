import Foundation
import UniformTypeIdentifiers

enum TrayIngestionInput: Sendable {
    case file(URL, typeIdentifier: String)
    case bytes(
        Data,
        kind: TrayItemKind,
        displayName: String,
        typeIdentifier: String,
        sourceURL: String? = nil,
        text: String? = nil
    )
}

struct TrayIngestionContext: Sendable {
    let collectionID: UUID
    let expiresAt: Date?
    let addedAt: Date
}

enum TrayIngestionError: Error, Equatable {
    case invalidName
    case materializationFailed
}

/// The only writer for durable tray payloads. Callers may acquire bytes in
/// different ways, but every ingress path uses this materialization and metadata
/// transaction before publishing an item on the main actor.
struct TrayIngestionPipeline: Sendable {
    let storageRoot: URL

    func materialize(
        _ input: TrayIngestionInput,
        context: TrayIngestionContext
    ) throws -> TrayItem {
        let id = UUID()
        let folder = storageRoot.appendingPathComponent(id.uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: folder, withIntermediateDirectories: true
            )

            let metadata: (
                kind: TrayItemKind,
                displayName: String,
                destination: URL,
                typeIdentifier: String,
                sourceURL: String?,
                text: String?
            )

            switch input {
            case .file(let source, let typeIdentifier):
                let name = try Self.validatedName(source.lastPathComponent)
                let destination = folder.appendingPathComponent(name)
                try FileManager.default.copyItem(at: source, to: destination)
                let type = UTType(typeIdentifier)
                metadata = (
                    type?.conforms(to: .image) == true ? .image : .file,
                    name, destination, typeIdentifier, nil, nil
                )

            case .bytes(
                let data, let kind, let displayName, let typeIdentifier,
                let sourceURL, let text
            ):
                let name = try Self.validatedName(displayName)
                let destination = folder.appendingPathComponent(name)
                try data.write(to: destination, options: .atomic)
                metadata = (kind, name, destination, typeIdentifier, sourceURL, text)
            }

            let size = try Self.byteSize(of: metadata.destination)
            return TrayItem(
                id: id, kind: metadata.kind, displayName: metadata.displayName,
                relativePath: "\(id.uuidString)/\(metadata.displayName)",
                text: metadata.text, sourceURL: metadata.sourceURL,
                typeIdentifier: metadata.typeIdentifier, byteSize: size,
                addedAt: context.addedAt, expiresAt: context.expiresAt,
                collectionID: context.collectionID,
                isPinned: context.expiresAt == nil
            )
        } catch let error as TrayIngestionError {
            try? FileManager.default.removeItem(at: folder)
            throw error
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw TrayIngestionError.materializationFailed
        }
    }

    private static func validatedName(_ proposed: String) throws -> String {
        let name = proposed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != "..",
              !name.contains("/"), !name.contains(":") else {
            throw TrayIngestionError.invalidName
        }
        return name
    }

    private static func byteSize(of url: URL) throws -> Int64 {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
        if values.isDirectory != true { return Int64(values.fileSize ?? 0) }
        guard let enumerator = FileManager.default.enumerator(
            at: url, includingPropertiesForKeys: [.fileSizeKey]
        ) else { return 0 }
        var total: Int64 = 0
        for case let child as URL in enumerator {
            total += Int64((try? child.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }
}
