import AppKit
import SwiftUI
import Combine
import UniformTypeIdentifiers
import QuickLookThumbnailing

/// The file shelf. Copies dropped bytes into app storage immediately (drag temp
/// URLs are short-lived), snapshots a Quick Look thumbnail, and persists the list
/// across launches. Not sandboxed, so plain file URLs — no security-scoped bookmarks.
@MainActor
final class TrayManager: ObservableObject {

    @Published private(set) var items: [DropItem] = []
    @Published private(set) var collections: [TrayCollection] = [.shelf]
    @Published private(set) var loadIssue: String?

    let storageRoot: URL
    /// Temp copies for share-on-drop, kept out of the shelf and wiped each launch.
    let shareStagingRoot: URL
    private let persistence: Persistence
    private let imageCache: ImageCache
    private let settings: Settings
    private unowned let activities: ActivityManager
    private let storeFile = "tray.json"
    private let legacyBackupFile = "tray.v1.backup.json"
    private let corruptBackupFile = "tray.corrupt.backup.json"
    private let ingestionPipeline: TrayIngestionPipeline
    private var cancellables = Set<AnyCancellable>()

    init(persistence: Persistence, imageCache: ImageCache, settings: Settings, activities: ActivityManager) {
        self.persistence = persistence
        self.imageCache = imageCache
        self.settings = settings
        self.activities = activities
        self.storageRoot = persistence.directory(named: "CopiedItems")
        self.shareStagingRoot = persistence.directory(named: "ShareStaging")
        self.ingestionPipeline = TrayIngestionPipeline(storageRoot: self.storageRoot)
        let storageRoot = self.storageRoot

        if let data = persistence.loadData(from: storeFile) {
            if let store = persistence.decode(TrayStore.self, from: data),
               store.schemaVersion == TrayStore.currentSchemaVersion {
                let result = TrayStoreValidation.visibleStore(
                    store, fileExists: { relativePath in
                        FileManager.default.fileExists(
                            atPath: storageRoot.appendingPathComponent(relativePath).path
                        ) && FileManager.default.isReadableFile(
                            atPath: storageRoot.appendingPathComponent(relativePath).path
                        )
                    }
                )
                self.collections = result.store.collections
                self.items = result.store.items
                if result.quarantinedItemCount > 0 {
                    self.loadIssue = "\(result.quarantinedItemCount) missing tray item(s) were hidden."
                }
                // A successfully decoded v2 store proves the prior migration
                // survived one clean launch, so its one-time backup may go.
                if result.quarantinedItemCount == 0 {
                    persistence.removeFile(named: legacyBackupFile)
                }
            } else if let legacy = persistence.decode([LegacyDropItem].self, from: data) {
                let result = TrayStoreMigration.migrate(
                    legacy, ttlDays: settings.trayTTLDays,
                    fileExists: { relativePath in
                        FileManager.default.fileExists(
                            atPath: storageRoot.appendingPathComponent(relativePath).path
                        ) && FileManager.default.isReadableFile(
                            atPath: storageRoot.appendingPathComponent(relativePath).path
                        )
                    }
                )
                if persistence.writeBackupIfMissing(data, to: legacyBackupFile),
                   persistence.saveSynchronously(result.store, to: storeFile) {
                    self.collections = result.store.collections
                    self.items = result.store.items
                    if result.quarantinedItemCount > 0 {
                        self.loadIssue = "\(result.quarantinedItemCount) missing tray item(s) were hidden."
                    }
                } else {
                    self.loadIssue = "The existing tray could not be migrated safely."
                }
            } else {
                _ = persistence.writeBackupIfMissing(data, to: corruptBackupFile)
                self.loadIssue = "The tray index is unreadable; stored files were left untouched."
            }
        }
    }

    func start() {
        pruneExpired()
        clearStaging()
        preloadThumbnails()
        if let loadIssue {
            activities.peek(
                title: "Tray needs attention", message: loadIssue,
                symbol: "exclamationmark.triangle.fill", tint: .warning
            )
        }

        settings.$trayTTLDays
            .dropFirst()
            .sink { [weak self] _ in self?.pruneExpired() }
            .store(in: &cancellables)
        Publishers.Merge(
            NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification),
            NotificationCenter.default.publisher(for: .NSCalendarDayChanged)
        )
        .sink { [weak self] _ in self?.pruneExpired() }
        .store(in: &cancellables)
    }

    // MARK: - Inbound

    /// Returns immediately (correct drop animation); ingestion continues async.
    func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        for provider in providers {
            ingest(provider)
        }
        return true
    }

    private func ingest(_ provider: NSItemProvider) {
        let typeIdentifier = provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .data) ?? false
        }) ?? UTType.data.identifier

        let pipeline = ingestionPipeline
        let context = ingestionContext(collectionID: TrayCollection.shelfID)
        provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, error in
            guard let self, let url else {
                if error != nil { Log.tray.error("Drop provider failed") }
                return
            }
            // Copy bytes out synchronously; `url` dies when this handler returns.
            guard let item = try? pipeline.materialize(
                .file(url, typeIdentifier: typeIdentifier), context: context
            ) else {
                Log.tray.error("Tray materialization failed")
                return
            }
            Task { @MainActor [weak self] in self?.add([item]) }
        }
    }

    /// Common entry point for paste, screenshots, generated archives, and any
    /// future source that already owns stable bytes or a file URL.
    func ingest(
        _ inputs: [TrayIngestionInput],
        collectionID: UUID = TrayCollection.shelfID
    ) {
        guard !inputs.isEmpty else { return }
        let pipeline = ingestionPipeline
        let context = ingestionContext(collectionID: collectionID)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let results = inputs.compactMap { input in
                try? pipeline.materialize(input, context: context)
            }
            Task { @MainActor [weak self] in
                self?.add(results)
            }
        }
    }

    private func add(_ newItems: [DropItem]) {
        guard !newItems.isEmpty else { return }
        items.insert(contentsOf: newItems, at: 0)
        persist()
        let message = newItems.count == 1
            ? newItems[0].displayName
            : "\(newItems.count) items"
        activities.peek(
            title: "Added to Shelf", message: message,
            symbol: "tray.and.arrow.down.fill", tint: .success
        )
        for item in newItems {
            Self.makeThumbnail(for: item, root: storageRoot) { [weak self] image in
                Task { @MainActor in
                    guard let self else { return }
                    if let image {
                        self.imageCache.store(image, forKey: self.thumbnailKey(for: item))
                    }
                    self.objectWillChange.send()
                }
            }
        }
    }

    /// Copy dropped files into the staging dir for an immediate share (the drop
    /// URLs are gone once the handler returns) without adding them to the shelf.
    /// `completion` runs on the main actor with the staged copies.
    func stageForShare(_ providers: [NSItemProvider], completion: @escaping @MainActor ([URL]) -> Void) {
        let group = DispatchGroup()
        let staged = URLAccumulator()

        for provider in providers {
            let typeIdentifier = provider.registeredTypeIdentifiers.first(where: {
                UTType($0)?.conforms(to: .data) ?? false
            }) ?? UTType.data.identifier

            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [root = shareStagingRoot] url, error in
                defer { group.leave() }
                guard let url else {
                    if let error { Log.tray.error("Share staging failed: \(error.localizedDescription)") }
                    return
                }
                guard let dest = Self.stageCopy(url, root: root) else { return }
                staged.append(dest)
            }
        }

        group.notify(queue: .main) {
            MainActor.assumeIsolated { completion(staged.values) }
        }
    }

    // MARK: - Mutation

    func remove(_ item: DropItem) {
        items.removeAll { $0.id == item.id }
        let folder = storageRoot.appendingPathComponent(item.id.uuidString, isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        persist()
    }

    func clear() {
        for item in items {
            let folder = storageRoot.appendingPathComponent(item.id.uuidString, isDirectory: true)
            try? FileManager.default.removeItem(at: folder)
        }
        items.removeAll()
        persist()
    }

    func fileURL(for item: DropItem) -> URL {
        item.url(relativeTo: storageRoot)
    }

    func thumbnail(for item: DropItem) -> NSImage? {
        imageCache.image(forKey: thumbnailKey(for: item))
    }

    // MARK: - Persistence / TTL

    private func persist() {
        persistence.save(
            TrayStore(
                schemaVersion: TrayStore.currentSchemaVersion,
                collections: collections, items: items
            ).normalized,
            to: storeFile
        )
    }

    private func pruneExpired() {
        let now = Date()
        let expired = items.filter {
            !$0.isPinned && $0.expiresAt.map { $0 <= now } == true
        }
        guard !expired.isEmpty else { return }
        let expiredIDs = Set(expired.map(\.id))
        for item in expired {
            let folder = storageRoot.appendingPathComponent(item.id.uuidString, isDirectory: true)
            try? FileManager.default.removeItem(at: folder)
        }
        items.removeAll { expiredIDs.contains($0.id) }
        persist()
    }

    private func ingestionContext(collectionID: UUID) -> TrayIngestionContext {
        let addedAt = Date()
        let days = collections.first(where: { $0.id == collectionID })?
            .expiryDaysOverride ?? settings.trayTTLDays
        return TrayIngestionContext(
            collectionID: collectionID,
            expiresAt: days > 0
                ? addedAt.addingTimeInterval(Double(days) * 86_400)
                : nil,
            addedAt: addedAt
        )
    }

    /// Staged share copies are transient; clear any left over from a prior run.
    private func clearStaging() {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: shareStagingRoot, includingPropertiesForKeys: nil) else { return }
        for entry in entries { try? fm.removeItem(at: entry) }
    }

    /// Release temporary share-on-drop copies as soon as the picker completes.
    func clearShareStaging() {
        clearStaging()
    }

    private func thumbnailKey(for item: DropItem) -> String {
        "tray.\(item.id.uuidString)"
    }

    private func preloadThumbnails() {
        let root = storageRoot
        let cache = imageCache
        let pending = items.map { ($0, thumbnailKey(for: $0)) }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var loaded = false
            for (item, key) in pending where cache.image(forKey: key) == nil {
                let url = item.thumbnailURL(relativeTo: root)
                guard let data = try? Data(contentsOf: url),
                      let image = cache.downsample(data: data, maxDimension: 160) else { continue }
                cache.store(image, forKey: key)
                loaded = true
            }
            guard loaded else { return }
            Task { @MainActor in self?.objectWillChange.send() }
        }
    }

    // MARK: - Off-main file work

    nonisolated private static func stageCopy(_ source: URL, root: URL) -> URL? {
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let destination = folder.appendingPathComponent(source.lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: destination)
            return destination
        } catch {
            Log.tray.error("Share staging copy failed: \(error.localizedDescription)")
            return nil
        }
    }

    nonisolated private static func makeThumbnail(
        for item: DropItem,
        root: URL,
        completion: @escaping @Sendable (NSImage?) -> Void
    ) {
        let fileURL = item.url(relativeTo: root)
        let request = QLThumbnailGenerator.Request(
            fileAt: fileURL,
            size: CGSize(width: 320, height: 320),
            scale: 2,
            representationTypes: .all
        )
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, _ in
            guard let cg = representation?.cgImage else { completion(nil); return }
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let data = rep.representation(using: .png, properties: [:]) else {
                completion(nil)
                return
            }
            try? data.write(to: item.thumbnailURL(relativeTo: root), options: .atomic)
            completion(NSImage(cgImage: cg, size: NSSize(width: 160, height: 160)))
        }
    }
}

private final class URLAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URL] = []

    func append(_ url: URL) {
        lock.lock()
        storage.append(url)
        lock.unlock()
    }

    var values: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
