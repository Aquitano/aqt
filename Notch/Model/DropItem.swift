import Foundation
import UniformTypeIdentifiers

struct TrayStore: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 2

    var schemaVersion: Int
    var collections: [TrayCollection]
    var items: [TrayItem]

    static var empty: TrayStore {
        TrayStore(
            schemaVersion: currentSchemaVersion,
            collections: [.shelf],
            items: []
        )
    }

    var normalized: TrayStore {
        var copy = self
        copy.schemaVersion = Self.currentSchemaVersion
        if !copy.collections.contains(where: { $0.id == TrayCollection.shelfID }) {
            copy.collections.insert(.shelf, at: 0)
        }
        let validCollectionIDs = Set(copy.collections.map(\.id))
        copy.items = copy.items.map { item in
            guard validCollectionIDs.contains(item.collectionID) else {
                var repaired = item
                repaired.collectionID = TrayCollection.shelfID
                return repaired
            }
            return item
        }
        return copy
    }
}

struct TrayCollection: Identifiable, Codable, Equatable, Hashable, Sendable {
    static let shelfID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    static let shelf = TrayCollection(
        id: shelfID, name: "Shelf", createdAt: Date(timeIntervalSince1970: 0),
        expiryDaysOverride: nil, sortOrder: 0
    )

    var id: UUID
    var name: String
    var createdAt: Date
    var expiryDaysOverride: Int?
    var sortOrder: Int
}

enum TrayItemKind: String, Codable, Equatable, Hashable, Sendable {
    case file
    case image
    case text
    case url
}

/// One materialized payload in Notch-owned storage. Every item kind has a
/// managed representation, so previews and outbound drags never depend on a
/// provider-temporary URL.
struct TrayItem: Identifiable, Codable, Equatable, Hashable, Sendable {
    var id: UUID
    var kind: TrayItemKind
    var displayName: String
    var relativePath: String?
    var text: String?
    var sourceURL: String?
    var typeIdentifier: String
    var byteSize: Int64
    var addedAt: Date
    var expiresAt: Date?
    var collectionID: UUID
    var isPinned: Bool

    var fileName: String {
        get { displayName }
        set { displayName = newValue }
    }

    var contentType: UTType {
        UTType(typeIdentifier) ?? .data
    }

    func url(relativeTo root: URL) -> URL {
        root.appendingPathComponent(relativePath ?? "\(id.uuidString)/\(displayName)")
    }

    func thumbnailURL(relativeTo root: URL) -> URL {
        url(relativeTo: root).deletingPathExtension()
            .appendingPathExtension("thumbnail.png")
    }
}

/// Source schema used only to decode the original unversioned `tray.json`.
struct LegacyDropItem: Codable, Equatable, Sendable {
    let id: UUID
    var fileName: String
    var relativePath: String
    var byteSize: Int64
    var addedAt: Date
    var typeIdentifier: String
}

struct TrayMigrationResult: Equatable, Sendable {
    var store: TrayStore
    var quarantinedItemCount: Int
}

enum TrayStoreMigration {
    static func migrate(
        _ legacy: [LegacyDropItem],
        ttlDays: Int,
        fileExists: (String) -> Bool
    ) -> TrayMigrationResult {
        var quarantined = 0
        let items = legacy.compactMap { old -> TrayItem? in
            guard fileExists(old.relativePath) else {
                quarantined += 1
                return nil
            }
            let type = UTType(old.typeIdentifier)
            let kind: TrayItemKind = type?.conforms(to: .image) == true ? .image : .file
            let expiry = ttlDays > 0
                ? old.addedAt.addingTimeInterval(Double(ttlDays) * 86_400)
                : nil
            return TrayItem(
                id: old.id, kind: kind, displayName: old.fileName,
                relativePath: old.relativePath, text: nil, sourceURL: nil,
                typeIdentifier: old.typeIdentifier, byteSize: old.byteSize,
                addedAt: old.addedAt, expiresAt: expiry,
                collectionID: TrayCollection.shelfID, isPinned: expiry == nil
            )
        }
        return TrayMigrationResult(
            store: TrayStore(
                schemaVersion: TrayStore.currentSchemaVersion,
                collections: [.shelf], items: items
            ),
            quarantinedItemCount: quarantined
        )
    }
}

enum TrayStoreValidation {
    static func visibleStore(
        _ store: TrayStore,
        fileExists: (String) -> Bool
    ) -> TrayMigrationResult {
        let normalized = store.normalized
        var quarantined = 0
        let visible = normalized.items.filter { item in
            guard let relativePath = item.relativePath,
                  fileExists(relativePath) else {
                quarantined += 1
                return false
            }
            return true
        }
        return TrayMigrationResult(
            store: TrayStore(
                schemaVersion: TrayStore.currentSchemaVersion,
                collections: normalized.collections,
                items: visible
            ),
            quarantinedItemCount: quarantined
        )
    }
}

/// Compatibility name while the existing tray views move to richer item APIs.
typealias DropItem = TrayItem
