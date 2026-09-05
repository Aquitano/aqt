import Foundation
import UniformTypeIdentifiers

package struct TrayStore: Codable, Equatable, Sendable {
    package static let currentSchemaVersion = 2

    package var schemaVersion: Int
    package var collections: [TrayCollection]
    package var items: [TrayItem]

    package init(schemaVersion: Int, collections: [TrayCollection], items: [TrayItem]) {
        self.schemaVersion = schemaVersion
        self.collections = collections
        self.items = items
    }

    package static var empty: TrayStore {
        TrayStore(
            schemaVersion: currentSchemaVersion,
            collections: [.shelf],
            items: []
        )
    }

    package var normalized: TrayStore {
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

package struct TrayCollection: Identifiable, Codable, Equatable, Hashable, Sendable {
    package static let shelfID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    package static let shelf = TrayCollection(
        id: shelfID, name: "Shelf", createdAt: Date(timeIntervalSince1970: 0),
        expiryDaysOverride: nil, sortOrder: 0
    )

    package var id: UUID
    package var name: String
    package var createdAt: Date
    package var expiryDaysOverride: Int?
    package var sortOrder: Int

    package init(id: UUID, name: String, createdAt: Date, expiryDaysOverride: Int? = nil, sortOrder: Int) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.expiryDaysOverride = expiryDaysOverride
        self.sortOrder = sortOrder
    }
}

package enum TrayItemKind: String, Codable, Equatable, Hashable, Sendable {
    case file
    case image
    case text
    case url
}

/// One materialized payload in Notch-owned storage. Every item kind has a
/// managed representation, so previews and outbound drags never depend on a
/// provider-temporary URL.
package struct TrayItem: Identifiable, Codable, Equatable, Hashable, Sendable {
    package var id: UUID
    package var kind: TrayItemKind
    package var displayName: String
    package var relativePath: String?
    package var text: String?
    package var sourceURL: String?
    package var typeIdentifier: String
    package var byteSize: Int64
    package var addedAt: Date
    package var expiresAt: Date?
    package var collectionID: UUID
    package var isPinned: Bool
    package var cleanupError: Bool? = nil

    package var fileName: String {
        get { displayName }
        set { displayName = newValue }
    }

    package var contentType: UTType {
        UTType(typeIdentifier) ?? .data
    }

    package func url(relativeTo root: URL) -> URL {
        root.appendingPathComponent(relativePath ?? "\(id.uuidString)/\(displayName)")
    }

    package func thumbnailURL(relativeTo root: URL) -> URL {
        url(relativeTo: root).deletingPathExtension()
            .appendingPathExtension("thumbnail.png")
    }
}

/// Source schema used only to decode the original unversioned `tray.json`.
package struct LegacyDropItem: Codable, Equatable, Sendable {
    package let id: UUID
    package var fileName: String
    package var relativePath: String
    package var byteSize: Int64
    package var addedAt: Date
    package var typeIdentifier: String
}

package struct TrayMigrationResult: Equatable, Sendable {
    package var store: TrayStore
    package var quarantinedItemCount: Int
}

package enum TrayStoreMigration {
    package static func migrate(
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

package enum TrayStoreValidation {
    package static func visibleStore(
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
package typealias DropItem = TrayItem
