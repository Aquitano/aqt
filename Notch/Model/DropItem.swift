import Foundation
import AppKit
import UniformTypeIdentifiers
import CoreTransferable

/// A file staged in the tray. Bytes are copied into app storage on drop (drag
/// temp URLs are short-lived), a Quick Look thumbnail is snapshotted, and the
/// whole thing is Codable so the shelf survives relaunch.
struct DropItem: Identifiable, Codable, Equatable, Hashable {
    let id: UUID
    var fileName: String
    /// Path relative to the CopiedItems root, so the store is portable.
    var relativePath: String
    var byteSize: Int64
    var addedAt: Date
    var typeIdentifier: String

    init(id: UUID = UUID(),
         fileName: String,
         relativePath: String,
         byteSize: Int64,
         addedAt: Date,
         typeIdentifier: String) {
        self.id = id
        self.fileName = fileName
        self.relativePath = relativePath
        self.byteSize = byteSize
        self.addedAt = addedAt
        self.typeIdentifier = typeIdentifier
    }

    var contentType: UTType {
        UTType(typeIdentifier) ?? .data
    }

    func url(relativeTo root: URL) -> URL {
        root.appendingPathComponent(relativePath)
    }

    /// Sidecar thumbnail path next to the copied file.
    func thumbnailURL(relativeTo root: URL) -> URL {
        url(relativeTo: root).deletingPathExtension().appendingPathExtension("thumbnail.png")
    }

    static func == (lhs: DropItem, rhs: DropItem) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
