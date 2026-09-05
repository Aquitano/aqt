import Foundation
@testable import NotchCore
import Testing
import UniformTypeIdentifiers

struct TrayStoreTests {
    @Test func representationPriorityIsFileImageURLThenText() {
        #expect(TrayDropCapabilities.preferredKind(for: [
            UTType.plainText.identifier, UTType.url.identifier,
            UTType.png.identifier, UTType.fileURL.identifier,
        ]) == .fileURLs)
        #expect(TrayDropCapabilities.preferredKind(for: [
            UTType.plainText.identifier, UTType.url.identifier, UTType.png.identifier,
        ]) == .image)
        #expect(TrayDropCapabilities.preferredKind(for: [
            UTType.plainText.identifier, UTType.url.identifier,
        ]) == .webURL)
        #expect(TrayDropCapabilities.preferredKind(for: [
            UTType.utf8PlainText.identifier,
        ]) == .plainText)
    }

    @Test func dropCapabilitiesRejectUnrelatedData() {
        #expect(TrayDropCapabilities.preferredKind(for: [UTType.audio.identifier]) == nil)
    }

    @Test func fileNameValidationAndCollisionResolution() {
        #expect(TrayFileNamePolicy.validated("../escape") == nil)
        #expect(TrayFileNamePolicy.validated("a/b") == nil)
        #expect(TrayFileNamePolicy.validated(" résumé.txt ") == "résumé.txt")
        #expect(
            TrayFileNamePolicy.availableName(
                "Report.txt", existing: ["report.txt", "Report 2.txt"]
            ) == "Report 3.txt"
        )
    }

    @Test func storeRoundTripPreservesRichMetadata() throws {
        let item = TrayItem(
            id: UUID(), kind: .text, displayName: "note.txt",
            relativePath: "item/note.txt", text: "hello", sourceURL: nil,
            typeIdentifier: UTType.plainText.identifier, byteSize: 5,
            addedAt: Date(timeIntervalSince1970: 10),
            expiresAt: Date(timeIntervalSince1970: 20),
            collectionID: TrayCollection.shelfID, isPinned: false
        )
        let store = TrayStore(
            schemaVersion: 2, collections: [.shelf], items: [item]
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(
            TrayStore.self, from: encoder.encode(store)
        )
        #expect(decoded == store)
    }

    @Test func migrationPreservesIdentityMetadataAndEffectiveTTL() {
        let id = UUID()
        let added = Date(timeIntervalSince1970: 1000)
        let result = TrayStoreMigration.migrate([
            LegacyDropItem(
                id: id, fileName: "photo.png", relativePath: "id/photo.png",
                byteSize: 42, addedAt: added,
                typeIdentifier: UTType.png.identifier
            ),
        ], ttlDays: 7, fileExists: { _ in true })

        #expect(result.quarantinedItemCount == 0)
        #expect(result.store.collections == [.shelf])
        #expect(result.store.items.first?.id == id)
        #expect(result.store.items.first?.kind == .image)
        #expect(result.store.items.first?.relativePath == "id/photo.png")
        #expect(result.store.items.first?.byteSize == 42)
        #expect(result.store.items.first?.expiresAt == added.addingTimeInterval(7 * 86400))
    }

    @Test func migrationQuarantinesMissingPayloadWithoutTouchingOthers() {
        let present = LegacyDropItem(
            id: UUID(), fileName: "present.txt", relativePath: "a/present.txt",
            byteSize: 1, addedAt: .distantPast,
            typeIdentifier: UTType.plainText.identifier
        )
        let missing = LegacyDropItem(
            id: UUID(), fileName: "missing.txt", relativePath: "b/missing.txt",
            byteSize: 1, addedAt: .distantPast,
            typeIdentifier: UTType.plainText.identifier
        )
        let result = TrayStoreMigration.migrate(
            [present, missing], ttlDays: 0,
            fileExists: { $0 == present.relativePath }
        )
        #expect(result.store.items.map { $0.id } == [present.id])
        #expect(result.quarantinedItemCount == 1)
        #expect(result.store.items[0].isPinned)
        #expect(result.store.items[0].expiresAt == nil)
    }

    @Test func normalizationRestoresShelfAndRepairsOrphanedCollection() {
        var item = fixtureItem()
        item.collectionID = UUID()
        let normalized = TrayStore(
            schemaVersion: 1, collections: [], items: [item]
        ).normalized
        #expect(normalized.schemaVersion == 2)
        #expect(normalized.collections == [.shelf])
        #expect(normalized.items[0].collectionID == TrayCollection.shelfID)
    }

    @Test func v2ValidationQuarantinesMissingMaterializedPayload() {
        let present = fixtureItem()
        var missing = fixtureItem()
        missing.relativePath = "missing/file"
        let result = TrayStoreValidation.visibleStore(
            TrayStore(schemaVersion: 2, collections: [.shelf], items: [present, missing]),
            fileExists: { $0 == present.relativePath }
        )
        #expect(result.store.items.map(\.id) == [present.id])
        #expect(result.quarantinedItemCount == 1)
    }

    @Test func pipelineMaterializesFileAndBytesThroughSameFolderContract() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source.bin")
        try Data([1, 2, 3]).write(to: source)
        let storage = root.appendingPathComponent("storage", isDirectory: true)
        let pipeline = TrayIngestionPipeline(storageRoot: storage)
        let context = TrayIngestionContext(
            collectionID: TrayCollection.shelfID,
            expiresAt: Date(timeIntervalSince1970: 200),
            addedAt: Date(timeIntervalSince1970: 100)
        )

        let file = try pipeline.materialize(
            .file(source, typeIdentifier: UTType.data.identifier), context: context
        )
        let text = try pipeline.materialize(
            .bytes(
                Data("hello".utf8), kind: .text, displayName: "note.txt",
                typeIdentifier: UTType.plainText.identifier, text: "hello"
            ),
            context: context
        )

        #expect(file.byteSize == 3)
        #expect(text.text == "hello")
        #expect(FileManager.default.fileExists(atPath: file.url(relativeTo: storage).path))
        #expect(FileManager.default.fileExists(atPath: text.url(relativeTo: storage).path))
        #expect(file.collectionID == text.collectionID)
        #expect(file.expiresAt == text.expiresAt)
    }

    @Test func pipelineRollsBackFolderWhenMaterializationFails() {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = root.appendingPathComponent("storage", isDirectory: true)
        let pipeline = TrayIngestionPipeline(storageRoot: storage)
        let context = TrayIngestionContext(
            collectionID: TrayCollection.shelfID,
            expiresAt: nil,
            addedAt: Date(timeIntervalSince1970: 100)
        )

        #expect(throws: (any Error).self) {
            try pipeline.materialize(
                .bytes(
                    Data(), kind: .text, displayName: "../escape.txt",
                    typeIdentifier: UTType.plainText.identifier
                ),
                context: context
            )
        }
        let entries = try? FileManager.default.contentsOfDirectory(
            at: storage, includingPropertiesForKeys: nil
        )
        #expect((entries ?? []) == [])
    }

    @Test func pipelineSameVolumeMovePublishesManagedPayloadAndRemovesSource() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("move-me.txt")
        try Data("move".utf8).write(to: source)
        let storage = root.appendingPathComponent("storage", isDirectory: true)
        let pipeline = TrayIngestionPipeline(storageRoot: storage)
        let item = try pipeline.materializeMovingFile(
            source, typeIdentifier: UTType.plainText.identifier,
            context: .init(
                collectionID: TrayCollection.shelfID, expiresAt: nil,
                addedAt: Date(timeIntervalSince1970: 100)
            )
        )
        #expect(!FileManager.default.fileExists(atPath: source.path))
        #expect(FileManager.default.isReadableFile(
            atPath: item.url(relativeTo: storage).path
        ))
        #expect(item.byteSize == 4)
    }

    @Test func backupIsCreatedOnceAndCanBeRetiredAfterCleanLaunch() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let persistence = Persistence(rootDirectory: root)
        let first = Data("legacy".utf8)
        try persistence.writeBackupIfMissing(first, to: "tray.v1.backup.json")
        try persistence.writeBackupIfMissing(Data("new".utf8), to: "tray.v1.backup.json")
        #expect(try persistence.loadData(from: "tray.v1.backup.json") == first)
        persistence.removeFile(named: "tray.v1.backup.json")
        #expect(try persistence.loadData(from: "tray.v1.backup.json") == nil)
    }

    @Test func collectionDeletionCanReassignOrDeleteItems() {
        let collection = TrayCollection(
            id: UUID(), name: "Sprint", createdAt: .distantPast,
            expiryDaysOverride: 2, sortOrder: 1
        )
        var item = fixtureItem()
        item.collectionID = collection.id
        let collections = [TrayCollection.shelf, collection]

        let reassigned = TrayCollectionPolicy.deleting(
            collectionID: collection.id, policy: .moveItemsToShelf,
            collections: collections, items: [item]
        )
        #expect(reassigned?.items.first?.collectionID == TrayCollection.shelfID)
        #expect(reassigned?.itemIDsToDelete == [])

        let deleted = TrayCollectionPolicy.deleting(
            collectionID: collection.id, policy: .deleteItems,
            collections: collections, items: [item]
        )
        #expect(deleted?.items == [])
        #expect(deleted?.itemIDsToDelete == [item.id])
        #expect(TrayCollectionPolicy.deleting(
            collectionID: TrayCollection.shelfID, policy: .deleteItems,
            collections: collections, items: [item]
        ) == nil)
    }

    @Test func expiryInheritanceExtensionAndNearestDeadline() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var first = fixtureItem()
        first.isPinned = false
        first.addedAt = now
        first.expiresAt = TrayExpiryPolicy.deadline(addedAt: now, days: 2)
        var second = fixtureItem()
        second.isPinned = false
        second.addedAt = now
        second.expiresAt = TrayExpiryPolicy.deadline(addedAt: now, days: 4)
        #expect(TrayExpiryPolicy.nearestDeadline(in: [second, first], after: now) == first.expiresAt)
        let updated = TrayExpiryPolicy.applying(days: 7, to: [first, second])
        #expect(updated[0].expiresAt == now.addingTimeInterval(7 * 86400))
        #expect(TrayExpiryPresentation.make(for: first, now: now, lifetimeDays: 2)?.label == "2d left")
    }

    @Test func moveEligibilityAndVerifiedOutcome() {
        #expect(TrayMoveEligibility.evaluate(.init(
            isFileURL: true, isWritable: true, volumeIsReadOnly: false,
            isUbiquitous: false, isDownloaded: true
        )) == .eligible)
        #expect(TrayMoveEligibility.evaluate(.init(
            isFileURL: true, isWritable: true, volumeIsReadOnly: false,
            isUbiquitous: true, isDownloaded: false
        )) == .copyOnly)
        #expect(
            TrayMoveOutcome.resolve(destinationVerified: true, sourceRemoved: false)
                == .copiedOriginalRetained
        )
        #expect(
            TrayMoveOutcome.resolve(destinationVerified: false, sourceRemoved: true)
                == .failed
        )
    }

    private func fixtureItem() -> TrayItem {
        TrayItem(
            id: UUID(), kind: .file, displayName: "file",
            relativePath: "id/file", text: nil, sourceURL: nil,
            typeIdentifier: UTType.data.identifier, byteSize: 0,
            addedAt: .distantPast, expiresAt: nil,
            collectionID: TrayCollection.shelfID, isPinned: true
        )
    }

    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
