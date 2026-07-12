import Foundation
import UniformTypeIdentifiers
import XCTest

final class TrayStoreTests: XCTestCase {
    func testRepresentationPriorityIsFileImageURLThenText() {
        XCTAssertEqual(TrayDropCapabilities.preferredKind(for: [
            UTType.plainText.identifier, UTType.url.identifier,
            UTType.png.identifier, UTType.fileURL.identifier
        ]), .fileURLs)
        XCTAssertEqual(TrayDropCapabilities.preferredKind(for: [
            UTType.plainText.identifier, UTType.url.identifier, UTType.png.identifier
        ]), .image)
        XCTAssertEqual(TrayDropCapabilities.preferredKind(for: [
            UTType.plainText.identifier, UTType.url.identifier
        ]), .webURL)
        XCTAssertEqual(TrayDropCapabilities.preferredKind(for: [
            UTType.utf8PlainText.identifier
        ]), .plainText)
    }

    func testDropCapabilitiesRejectUnrelatedData() {
        XCTAssertNil(TrayDropCapabilities.preferredKind(for: [UTType.audio.identifier]))
    }

    func testFileNameValidationAndCollisionResolution() {
        XCTAssertNil(TrayFileNamePolicy.validated("../escape"))
        XCTAssertNil(TrayFileNamePolicy.validated("a/b"))
        XCTAssertEqual(TrayFileNamePolicy.validated(" résumé.txt "), "résumé.txt")
        XCTAssertEqual(
            TrayFileNamePolicy.availableName(
                "Report.txt", existing: ["report.txt", "Report 2.txt"]
            ),
            "Report 3.txt"
        )
    }

    func testStoreRoundTripPreservesRichMetadata() throws {
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
        XCTAssertEqual(decoded, store)
    }

    func testMigrationPreservesIdentityMetadataAndEffectiveTTL() {
        let id = UUID()
        let added = Date(timeIntervalSince1970: 1_000)
        let result = TrayStoreMigration.migrate([
            LegacyDropItem(
                id: id, fileName: "photo.png", relativePath: "id/photo.png",
                byteSize: 42, addedAt: added,
                typeIdentifier: UTType.png.identifier
            )
        ], ttlDays: 7, fileExists: { _ in true })

        XCTAssertEqual(result.quarantinedItemCount, 0)
        XCTAssertEqual(result.store.collections, [.shelf])
        XCTAssertEqual(result.store.items.first?.id, id)
        XCTAssertEqual(result.store.items.first?.kind, .image)
        XCTAssertEqual(result.store.items.first?.relativePath, "id/photo.png")
        XCTAssertEqual(result.store.items.first?.byteSize, 42)
        XCTAssertEqual(
            result.store.items.first?.expiresAt,
            added.addingTimeInterval(7 * 86_400)
        )
    }

    func testMigrationQuarantinesMissingPayloadWithoutTouchingOthers() {
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
        XCTAssertEqual(result.store.items.map(\.id), [present.id])
        XCTAssertEqual(result.quarantinedItemCount, 1)
        XCTAssertTrue(result.store.items[0].isPinned)
        XCTAssertNil(result.store.items[0].expiresAt)
    }

    func testNormalizationRestoresShelfAndRepairsOrphanedCollection() {
        var item = fixtureItem()
        item.collectionID = UUID()
        let normalized = TrayStore(
            schemaVersion: 1, collections: [], items: [item]
        ).normalized
        XCTAssertEqual(normalized.schemaVersion, 2)
        XCTAssertEqual(normalized.collections, [.shelf])
        XCTAssertEqual(normalized.items[0].collectionID, TrayCollection.shelfID)
    }

    func testV2ValidationQuarantinesMissingMaterializedPayload() {
        let present = fixtureItem()
        var missing = fixtureItem()
        missing.relativePath = "missing/file"
        let result = TrayStoreValidation.visibleStore(
            TrayStore(schemaVersion: 2, collections: [.shelf], items: [present, missing]),
            fileExists: { $0 == present.relativePath }
        )
        XCTAssertEqual(result.store.items.map(\.id), [present.id])
        XCTAssertEqual(result.quarantinedItemCount, 1)
    }

    func testPipelineMaterializesFileAndBytesThroughSameFolderContract() throws {
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

        XCTAssertEqual(file.byteSize, 3)
        XCTAssertEqual(text.text, "hello")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.url(relativeTo: storage).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: text.url(relativeTo: storage).path))
        XCTAssertEqual(file.collectionID, text.collectionID)
        XCTAssertEqual(file.expiresAt, text.expiresAt)
    }

    func testPipelineRollsBackFolderWhenMaterializationFails() {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = root.appendingPathComponent("storage", isDirectory: true)
        let pipeline = TrayIngestionPipeline(storageRoot: storage)
        let context = TrayIngestionContext(
            collectionID: TrayCollection.shelfID,
            expiresAt: nil,
            addedAt: Date(timeIntervalSince1970: 100)
        )

        XCTAssertThrowsError(try pipeline.materialize(
            .bytes(
                Data(), kind: .text, displayName: "../escape.txt",
                typeIdentifier: UTType.plainText.identifier
            ),
            context: context
        ))
        let entries = try? FileManager.default.contentsOfDirectory(
            at: storage, includingPropertiesForKeys: nil
        )
        XCTAssertEqual(entries ?? [], [])
    }

    func testPipelineSameVolumeMovePublishesManagedPayloadAndRemovesSource() throws {
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
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertTrue(FileManager.default.isReadableFile(
            atPath: item.url(relativeTo: storage).path
        ))
        XCTAssertEqual(item.byteSize, 4)
    }

    func testBackupIsCreatedOnceAndCanBeRetiredAfterCleanLaunch() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let persistence = Persistence(rootDirectory: root)
        let first = Data("legacy".utf8)
        XCTAssertTrue(persistence.writeBackupIfMissing(first, to: "tray.v1.backup.json"))
        XCTAssertTrue(persistence.writeBackupIfMissing(Data("new".utf8), to: "tray.v1.backup.json"))
        XCTAssertEqual(persistence.loadData(from: "tray.v1.backup.json"), first)
        persistence.removeFile(named: "tray.v1.backup.json")
        XCTAssertNil(persistence.loadData(from: "tray.v1.backup.json"))
    }

    func testCollectionDeletionCanReassignOrDeleteItems() {
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
        XCTAssertEqual(reassigned?.items.first?.collectionID, TrayCollection.shelfID)
        XCTAssertEqual(reassigned?.itemIDsToDelete, [])

        let deleted = TrayCollectionPolicy.deleting(
            collectionID: collection.id, policy: .deleteItems,
            collections: collections, items: [item]
        )
        XCTAssertEqual(deleted?.items, [])
        XCTAssertEqual(deleted?.itemIDsToDelete, [item.id])
        XCTAssertNil(TrayCollectionPolicy.deleting(
            collectionID: TrayCollection.shelfID, policy: .deleteItems,
            collections: collections, items: [item]
        ))
    }

    func testExpiryInheritanceExtensionAndNearestDeadline() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var first = fixtureItem()
        first.isPinned = false
        first.addedAt = now
        first.expiresAt = TrayExpiryPolicy.deadline(addedAt: now, days: 2)
        var second = fixtureItem()
        second.isPinned = false
        second.addedAt = now
        second.expiresAt = TrayExpiryPolicy.deadline(addedAt: now, days: 4)
        XCTAssertEqual(
            TrayExpiryPolicy.nearestDeadline(in: [second, first], after: now),
            first.expiresAt
        )
        let updated = TrayExpiryPolicy.applying(days: 7, to: [first, second])
        XCTAssertEqual(updated[0].expiresAt, now.addingTimeInterval(7 * 86_400))
        XCTAssertEqual(
            TrayExpiryPresentation.make(for: first, now: now, lifetimeDays: 2)?.label,
            "2d left"
        )
    }

    func testMoveEligibilityAndVerifiedOutcome() {
        XCTAssertEqual(TrayMoveEligibility.evaluate(.init(
            isFileURL: true, isWritable: true, volumeIsReadOnly: false,
            isUbiquitous: false, isDownloaded: true
        )), .eligible)
        XCTAssertEqual(TrayMoveEligibility.evaluate(.init(
            isFileURL: true, isWritable: true, volumeIsReadOnly: false,
            isUbiquitous: true, isDownloaded: false
        )), .copyOnly)
        XCTAssertEqual(
            TrayMoveOutcome.resolve(destinationVerified: true, sourceRemoved: false),
            .copiedOriginalRetained
        )
        XCTAssertEqual(
            TrayMoveOutcome.resolve(destinationVerified: false, sourceRemoved: true),
            .failed
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
