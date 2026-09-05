import AppKit
import NotchCore
import QuickLookThumbnailing
import SwiftUI
import UniformTypeIdentifiers

/// The file shelf. Copies dropped bytes into app storage immediately (drag temp
/// URLs are short-lived), snapshots a Quick Look thumbnail, and persists the list
/// across launches. Not sandboxed, so plain file URLs — no security-scoped bookmarks.
@MainActor
@Observable
final class TrayManager {
    private(set) var items: [DropItem] = []
    private(set) var collections: [TrayCollection] = [.shelf]
    private(set) var activeCollectionID = TrayCollection.shelfID
    private(set) var loadIssue: String?
    let quickLook = TrayQuickLookController()

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
    private var pruneTasks: [Task<Void, Never>] = []
    /// Bumped when a thumbnail finishes decoding so views reading `thumbnail(for:)`
    /// re-render; the image cache itself is not observable.
    private var thumbnailGeneration = 0
    private var expiryTask: Task<Void, Never>?

    var activeItems: [TrayItem] {
        items.filter { $0.collectionID == activeCollectionID }
    }

    var activeCollection: TrayCollection {
        collections.first(where: { $0.id == activeCollectionID }) ?? .shelf
    }

    init(persistence: Persistence, imageCache: ImageCache, settings: Settings, activities: ActivityManager) {
        self.persistence = persistence
        self.imageCache = imageCache
        self.settings = settings
        self.activities = activities
        self.storageRoot = persistence.directory(named: "CopiedItems")
        self.shareStagingRoot = persistence.directory(named: "ShareStaging")
        self.ingestionPipeline = TrayIngestionPipeline(storageRoot: self.storageRoot)
        let storageRoot = self.storageRoot

        if let data = try? persistence.loadData(from: storeFile) {
            if let store = try? persistence.decode(TrayStore.self, from: data, file: storeFile),
               store.schemaVersion == TrayStore.currentSchemaVersion
            {
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
            } else if let legacy = try? persistence.decode([LegacyDropItem].self, from: data, file: storeFile) {
                let result = TrayStoreMigration.migrate(
                    legacy, ttlDays: settings.tray.ttlDays,
                    fileExists: { relativePath in
                        FileManager.default.fileExists(
                            atPath: storageRoot.appendingPathComponent(relativePath).path
                        ) && FileManager.default.isReadableFile(
                            atPath: storageRoot.appendingPathComponent(relativePath).path
                        )
                    }
                )
                do {
                    try persistence.writeBackupIfMissing(data, to: legacyBackupFile)
                    try persistence.saveSynchronously(result.store, to: storeFile)
                    self.collections = result.store.collections
                    self.items = result.store.items
                    if result.quarantinedItemCount > 0 {
                        self.loadIssue = "\(result.quarantinedItemCount) missing tray item(s) were hidden."
                    }
                } catch {
                    self.loadIssue = "The existing tray could not be migrated safely: \(error.localizedDescription)"
                }
            } else {
                try? persistence.writeBackupIfMissing(data, to: corruptBackupFile)
                self.loadIssue = "The tray index is unreadable; stored files were left untouched."
            }
        }
        if let savedID = UUID(uuidString: settings.tray.lastCollectionID),
           collections.contains(where: { $0.id == savedID })
        {
            activeCollectionID = savedID
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

        for name in [NSApplication.didBecomeActiveNotification, .NSCalendarDayChanged] {
            pruneTasks.append(Task { @MainActor [weak self] in
                for await _ in NotificationCenter.default.notifications(named: name) {
                    self?.pruneExpired()
                }
            })
        }
        scheduleNearestExpiry()
    }

    // MARK: - Inbound

    /// Returns immediately (correct drop animation); ingestion continues async.
    func handleDrop(
        _ providers: [NSItemProvider],
        moveOriginalURLs: [URL] = []
    ) -> Bool {
        if settings.tray.moveEnabled, !moveOriginalURLs.isEmpty {
            return moveOriginalFiles(moveOriginalURLs, collectionID: activeCollectionID)
        }
        guard !providers.isEmpty else { return false }
        let batch = TrayProviderIngestionBatch(expectedCount: providers.count) { [weak self] result in
            Task { @MainActor [weak self] in
                self?.add(result.items, failedCount: result.failedCount)
            }
        }
        for provider in providers {
            ingest(provider, batch: batch)
        }
        return true
    }

    private func ingest(_ provider: NSItemProvider, batch: TrayProviderIngestionBatch) {
        let identifiers = provider.registeredTypeIdentifiers
        guard let kind = TrayDropCapabilities.preferredKind(for: identifiers),
              let typeIdentifier = TrayDropCapabilities.preferredTypeIdentifier(
                  for: kind, in: identifiers
              )
        else {
            batch.finish(nil)
            return
        }
        let pipeline = ingestionPipeline
        let context = ingestionContext(collectionID: activeCollectionID)

        switch kind {
        case .fileURLs:
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
                let item = url.flatMap {
                    try? pipeline.materialize(
                        .file($0, typeIdentifier: Self.inferredTypeIdentifier(for: $0)),
                        context: context
                    )
                }
                batch.finish(item)
            }

        case .image:
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                let extensionName = UTType(typeIdentifier)?.preferredFilenameExtension ?? "img"
                let item = data.flatMap {
                    try? pipeline.materialize(
                        .bytes(
                            $0, kind: .image,
                            displayName: "Dropped Image.\(extensionName)",
                            typeIdentifier: typeIdentifier
                        ),
                        context: context
                    )
                }
                batch.finish(item)
            }

        case .webURL:
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { value, _ in
                guard let url = Self.webURL(from: value),
                      let data = Self.weblocData(for: url)
                else {
                    batch.finish(nil)
                    return
                }
                let name = (url.host?.isEmpty == false ? url.host! : "Link") + ".webloc"
                let item = try? pipeline.materialize(
                    .bytes(
                        data, kind: .url, displayName: name,
                        typeIdentifier: UTType.internetLocation.identifier,
                        sourceURL: url.absoluteString, text: url.absoluteString
                    ),
                    context: context
                )
                batch.finish(item)
            }

        case .plainText:
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { value, _ in
                guard let text = Self.plainText(from: value), !text.isEmpty else {
                    batch.finish(nil)
                    return
                }
                let item = try? pipeline.materialize(
                    .bytes(
                        Data(text.utf8), kind: .text,
                        displayName: "Dropped Text.txt",
                        typeIdentifier: UTType.plainText.identifier, text: text
                    ),
                    context: context
                )
                batch.finish(item)
            }
        }
    }

    /// Common entry point for paste, screenshots, generated archives, and any
    /// future source that already owns stable bytes or a file URL.
    func ingest(
        _ inputs: [TrayIngestionInput],
        collectionID: UUID? = nil
    ) {
        guard !inputs.isEmpty else { return }
        let pipeline = ingestionPipeline
        let context = ingestionContext(collectionID: collectionID ?? activeCollectionID)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var failed = 0
            let results = inputs.compactMap { input -> TrayItem? in
                guard let item = try? pipeline.materialize(input, context: context) else {
                    failed += 1
                    return nil
                }
                return item
            }
            Task { @MainActor [weak self] in
                self?.add(results, failedCount: failed)
            }
        }
    }

    func clipboardRequiresConfirmation() -> Bool {
        let pasteboard = NSPasteboard.general
        let types = pasteboard.types?.map(\.rawValue) ?? []
        guard let kind = TrayDropCapabilities.preferredKind(for: types) else { return false }
        if kind == .fileURLs {
            let urls = pasteboard.readObjects(
                forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]
            ) as? [URL] ?? []
            return urls.count > 20
        }
        let identifier = TrayDropCapabilities.preferredTypeIdentifier(for: kind, in: types)
        return identifier.flatMap { pasteboard.data(forType: .init($0)) }?.count ?? 0 > 50_000_000
    }

    func pasteFromClipboard() {
        let pasteboard = NSPasteboard.general
        let identifiers = pasteboard.types?.map(\.rawValue) ?? []
        guard let kind = TrayDropCapabilities.preferredKind(for: identifiers) else {
            activities.peek(
                title: "Nothing to Paste", message: "No supported tray content",
                symbol: "doc.on.clipboard", tint: .warning
            )
            return
        }

        switch kind {
        case .fileURLs:
            let urls = pasteboard.readObjects(
                forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]
            ) as? [URL] ?? []
            var seen = Set<String>()
            let unique = urls.filter { seen.insert($0.standardizedFileURL.path).inserted }
            ingest(unique.map {
                .file($0, typeIdentifier: Self.inferredTypeIdentifier(for: $0))
            })

        case .image:
            guard let image = NSImage(pasteboard: pasteboard),
                  let data = Self.pngData(from: image) else { return }
            ingest([.bytes(
                data, kind: .image, displayName: "Clipboard Image.png",
                typeIdentifier: UTType.png.identifier
            )])

        case .webURL:
            guard let raw = pasteboard.string(forType: .URL),
                  let url = URL(string: raw),
                  let data = Self.weblocData(for: url) else { return }
            let name = (url.host?.isEmpty == false ? url.host! : "Link") + ".webloc"
            ingest([.bytes(
                data, kind: .url, displayName: name,
                typeIdentifier: UTType.internetLocation.identifier,
                sourceURL: url.absoluteString, text: url.absoluteString
            )])

        case .plainText:
            guard let text = pasteboard.string(forType: .string), !text.isEmpty else { return }
            ingest([.bytes(
                Data(text.utf8), kind: .text, displayName: "Clipboard Text.txt",
                typeIdentifier: UTType.plainText.identifier, text: text
            )])
        }
    }

    private func add(_ newItems: [DropItem], failedCount: Int = 0) {
        guard !newItems.isEmpty else {
            if failedCount > 0 {
                activities.peek(
                    title: "Couldn’t Add Items", message: "\(failedCount) failed",
                    symbol: "exclamationmark.triangle.fill", tint: .warning
                )
            }
            return
        }
        items.insert(contentsOf: newItems, at: 0)
        persist()
        scheduleNearestExpiry()
        var message = newItems.count == 1
            ? newItems[0].displayName
            : "\(newItems.count) items"
        if failedCount > 0 {
            message += " · \(failedCount) failed"
        }
        let destinationName = collections.first(where: {
            $0.id == newItems[0].collectionID
        })?.name ?? "Shelf"
        activities.peek(
            title: "Added to \(destinationName)", message: message,
            symbol: "tray.and.arrow.down.fill", tint: .success
        )
        for item in newItems {
            Self.makeThumbnail(for: item, root: storageRoot) { [weak self] image in
                Task { @MainActor in
                    guard let self else { return }
                    if let image {
                        self.imageCache.store(image, forKey: self.thumbnailKey(for: item))
                    }
                    self.thumbnailGeneration += 1
                }
            }
        }
    }

    /// Copy dropped files into the staging dir for an immediate share (the drop
    /// URLs are gone once the handler returns) without adding them to the shelf.
    /// `completion` runs on the main actor with the staged copies.
    func stageForShare(_ providers: [NSItemProvider], completion: @escaping @MainActor ([Any]) -> Void) {
        let group = DispatchGroup()
        let staged = ShareItemAccumulator()

        for provider in providers {
            let identifiers = provider.registeredTypeIdentifiers
            guard let kind = TrayDropCapabilities.preferredKind(for: identifiers),
                  let typeIdentifier = TrayDropCapabilities.preferredTypeIdentifier(
                      for: kind, in: identifiers
                  ) else { continue }

            group.enter()
            switch kind {
            case .fileURLs, .image:
                provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [root = shareStagingRoot] url, _ in
                    defer { group.leave() }
                    guard let url, let destination = Self.stageCopy(url, root: root) else { return }
                    staged.append(destination)
                }

            case .webURL:
                provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { value, _ in
                    defer { group.leave() }
                    if let url = Self.webURL(from: value) {
                        staged.append(url)
                    }
                }

            case .plainText:
                provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { value, _ in
                    defer { group.leave() }
                    if let text = Self.plainText(from: value) {
                        staged.append(text)
                    }
                }
            }
        }

        group.notify(queue: .main) {
            MainActor.assumeIsolated { completion(staged.values) }
        }
    }

    // MARK: - Mutation

    func selectCollection(_ id: UUID) {
        guard collections.contains(where: { $0.id == id }) else { return }
        activeCollectionID = id
        settings.tray.lastCollectionID = id.uuidString
    }

    @discardableResult
    func createCollection(named proposedName: String, expiryDays: Int? = nil) -> Bool {
        guard let name = TrayFileNamePolicy.validated(proposedName),
              !collections.contains(where: {
                  $0.name.compare(name, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
              }) else { return false }
        let collection = TrayCollection(
            id: UUID(), name: name, createdAt: Date(),
            expiryDaysOverride: expiryDays, sortOrder: collections.count
        )
        collections.append(collection)
        persist()
        selectCollection(collection.id)
        return true
    }

    @discardableResult
    func renameCollection(_ id: UUID, to proposedName: String) -> Bool {
        guard id != TrayCollection.shelfID,
              let name = TrayFileNamePolicy.validated(proposedName),
              let index = collections.firstIndex(where: { $0.id == id }),
              !collections.contains(where: {
                  $0.id != id && $0.name.compare(
                      name, options: [.caseInsensitive, .diacriticInsensitive]
                  ) == .orderedSame
              }) else { return false }
        collections[index].name = name
        persist()
        return true
    }

    func reorderCollection(_ id: UUID, by offset: Int) {
        guard id != TrayCollection.shelfID,
              let current = collections.firstIndex(where: { $0.id == id }) else { return }
        let destination = min(max(current + offset, 1), collections.count - 1)
        guard destination != current else { return }
        let moved = collections.remove(at: current)
        collections.insert(moved, at: destination)
        for index in collections.indices {
            collections[index].sortOrder = index
        }
        persist()
    }

    func setCollectionExpiry(_ id: UUID, days: Int?) {
        guard let index = collections.firstIndex(where: { $0.id == id }) else { return }
        collections[index].expiryDaysOverride = days
        persist()
    }

    func deleteCollection(_ id: UUID, policy: TrayCollectionDeletionPolicy) {
        guard id != TrayCollection.shelfID,
              collections.contains(where: { $0.id == id }) else { return }
        let affected = items.filter { $0.collectionID == id }
        quickLook.closeIfContains(Set(affected.map(\.id)))
        if policy == .moveItemsToShelf {
            for index in items.indices where items[index].collectionID == id {
                items[index].collectionID = TrayCollection.shelfID
            }
            finishDeletingCollection(id)
            return
        }
        deletePayloads(for: affected) { [weak self] deletedIDs, failedIDs in
            guard let self else { return }
            self.items.removeAll { deletedIDs.contains($0.id) }
            for index in self.items.indices where failedIDs.contains(self.items[index].id) {
                self.items[index].collectionID = TrayCollection.shelfID
                self.items[index].cleanupError = true
            }
            self.finishDeletingCollection(id)
            if !failedIDs.isEmpty {
                self.activities.peek(
                    title: "Cleanup Incomplete",
                    message: "\(failedIDs.count) item(s) moved to Shelf for retry",
                    symbol: "exclamationmark.triangle.fill", tint: .warning
                )
            }
        }
    }

    private func finishDeletingCollection(_ id: UUID) {
        collections.removeAll { $0.id == id }
        for index in collections.indices {
            collections[index].sortOrder = index
        }
        if activeCollectionID == id {
            selectCollection(TrayCollection.shelfID)
        }
        persist()
        scheduleNearestExpiry()
    }

    func move(_ selected: [TrayItem], to collectionID: UUID) {
        guard collections.contains(where: { $0.id == collectionID }) else { return }
        let ids = Set(selected.map(\.id))
        guard !ids.isEmpty else { return }
        quickLook.closeIfContains(ids)
        for index in items.indices where ids.contains(items[index].id) {
            items[index].collectionID = collectionID
        }
        persist()
        scheduleNearestExpiry()
    }

    func extend(_ selected: [TrayItem], byDays days: Int) {
        let ids = Set(selected.map(\.id))
        let now = Date()
        for index in items.indices where ids.contains(items[index].id) {
            items[index].isPinned = false
            items[index].cleanupError = nil
            let base = max(items[index].expiresAt ?? now, now)
            items[index].expiresAt = base.addingTimeInterval(Double(days) * 86400)
        }
        persist()
        scheduleNearestExpiry()
    }

    func applyGlobalTTLToExistingItems() {
        items = TrayExpiryPolicy.applying(days: settings.tray.ttlDays, to: items)
        persist()
        pruneExpired()
    }

    func expiryPresentation(for item: TrayItem, now: Date = Date()) -> TrayExpiryPresentation? {
        let days = collections.first(where: { $0.id == item.collectionID })?
            .expiryDaysOverride ?? settings.tray.ttlDays
        return TrayExpiryPresentation.make(for: item, now: now, lifetimeDays: days)
    }

    func soonestExpiry(in collectionID: UUID, now: Date = Date()) -> TrayExpiryPresentation? {
        let collectionItems = items.filter { $0.collectionID == collectionID }
        guard let item = collectionItems.filter({ !$0.isPinned }).min(by: {
            ($0.expiresAt ?? .distantFuture) < ($1.expiresAt ?? .distantFuture)
        }), let expiry = item.expiresAt, expiry.timeIntervalSince(now) < 86400 else { return nil }
        return expiryPresentation(for: item, now: now)
    }

    func remove(_ item: DropItem) {
        remove([item])
    }

    func clear() {
        remove(items)
    }

    func fileURL(for item: DropItem) -> URL {
        item.url(relativeTo: storageRoot)
    }

    func thumbnail(for item: DropItem) -> NSImage? {
        _ = thumbnailGeneration
        return imageCache.image(forKey: thumbnailKey(for: item))
    }

    func items(withIDs ids: Set<UUID>) -> [TrayItem] {
        items.filter { ids.contains($0.id) }
    }

    func itemProvider(for item: TrayItem, movingIDs: Set<UUID>? = nil) -> NSItemProvider {
        let managedURL = fileURL(for: item)
        let provider = NSItemProvider(contentsOf: managedURL) ?? NSItemProvider()
        provider.suggestedName = item.displayName
        switch item.kind {
        case .url:
            if let raw = item.sourceURL, let url = URL(string: raw) {
                provider.registerObject(url as NSURL, visibility: .all)
                provider.registerObject(raw as NSString, visibility: .all)
            }
        case .text:
            if let text = item.text {
                provider.registerObject(text as NSString, visibility: .all)
            }
        case .file, .image:
            break
        }
        let ids = movingIDs ?? [item.id]
        if let data = try? JSONEncoder().encode(Array(ids)) {
            provider.registerDataRepresentation(
                forTypeIdentifier: TrayDropCapabilities.internalItemIDsType,
                visibility: .ownProcess
            ) { completion in
                completion(data, nil)
                return nil
            }
        }
        return provider
    }

    func open(_ item: TrayItem) {
        if item.kind == .url, let raw = item.sourceURL, let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.open(fileURL(for: item))
        }
    }

    func copyPaths(_ selected: [TrayItem]) {
        guard !selected.isEmpty else { return }
        let value = selected.map { fileURL(for: $0).path }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    func copyContent(_ selected: [TrayItem]) {
        let values = selected.compactMap { item -> String? in
            switch item.kind {
            case .text: item.text
            case .url: item.sourceURL
            case .file, .image: nil
            }
        }
        guard !values.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(values.joined(separator: "\n"), forType: .string)
    }

    func setPinned(_ selected: [TrayItem], pinned: Bool) {
        guard !selected.isEmpty else { return }
        let ids = Set(selected.map(\.id))
        for index in items.indices where ids.contains(items[index].id) {
            items[index].isPinned = pinned
            items[index].cleanupError = nil
            let days = collections.first(where: {
                $0.id == items[index].collectionID
            })?.expiryDaysOverride ?? settings.tray.ttlDays
            items[index].expiresAt = pinned ? nil : TrayExpiryPolicy.deadline(
                addedAt: Date(), days: days
            )
        }
        persist()
        scheduleNearestExpiry()
    }

    func remove(_ selected: [TrayItem]) {
        let ids = Set(selected.map(\.id))
        guard !ids.isEmpty else { return }
        quickLook.closeIfContains(ids)
        deletePayloads(for: selected) { [weak self] deletedIDs, failedIDs in
            guard let self else { return }
            self.items.removeAll { deletedIDs.contains($0.id) }
            for index in self.items.indices where failedIDs.contains(self.items[index].id) {
                self.items[index].cleanupError = true
            }
            self.persist()
            self.scheduleNearestExpiry()
            if !failedIDs.isEmpty {
                self.activities.peek(
                    title: "Remove Incomplete", message: "Will retry later",
                    symbol: "exclamationmark.triangle.fill", tint: .warning
                )
            }
        }
    }

    func rename(_ item: TrayItem, to proposedName: String) {
        guard let name = TrayFileNamePolicy.validated(proposedName) else {
            activities.peek(
                title: "Rename Failed", message: "Choose a valid file name",
                symbol: "exclamationmark.triangle.fill", tint: .warning
            )
            return
        }
        guard name != item.displayName else { return }
        quickLook.closeIfContains([item.id])
        let root = storageRoot
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Self.renameTransaction(item: item, to: name, root: root)
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch result {
                case let .success(relativePath):
                    guard let index = self.items.firstIndex(where: { $0.id == item.id }) else { return }
                    self.items[index].displayName = name
                    self.items[index].relativePath = relativePath
                    self.persist()
                case .failure:
                    self.activities.peek(
                        title: "Rename Failed", message: "The original item is unchanged",
                        symbol: "exclamationmark.triangle.fill", tint: .warning
                    )
                }
            }
        }
    }

    func compress(_ selected: [TrayItem]) {
        guard !selected.isEmpty else { return }
        let urls = selected.map { fileURL(for: $0) }
        let stagingRoot = shareStagingRoot
        let pipeline = ingestionPipeline
        let context = ingestionContext(collectionID: selected[0].collectionID)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let workspace = Self.makeArchiveWorkspace(
                urls: urls, stagingRoot: stagingRoot
            ) else {
                Task { @MainActor [weak self] in
                    self?.activities.peek(
                        title: "Compress Failed", message: "No items were changed",
                        symbol: "exclamationmark.triangle.fill", tint: .warning
                    )
                }
                return
            }
            defer { try? FileManager.default.removeItem(at: workspace.folder) }
            let item = try? pipeline.materialize(
                .file(workspace.archive, typeIdentifier: UTType.zip.identifier),
                context: context
            )
            Task { @MainActor [weak self] in
                self?.add(item.map { [$0] } ?? [], failedCount: item == nil ? 1 : 0)
            }
        }
    }

    private func moveOriginalFiles(_ urls: [URL], collectionID: UUID) -> Bool {
        var seen = Set<String>()
        let sources = urls.filter {
            $0.isFileURL && seen.insert($0.standardizedFileURL.path).inserted
        }
        guard !sources.isEmpty else { return false }
        let pipeline = ingestionPipeline
        let root = storageRoot
        let context = ingestionContext(collectionID: collectionID)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var result = TrayMoveBatchResult()
            for source in sources {
                guard Self.moveEligibility(for: source) == .eligible else {
                    if let item = try? pipeline.materialize(
                        .file(source, typeIdentifier: Self.inferredTypeIdentifier(for: source)),
                        context: context
                    ) {
                        result.items.append(item)
                        result.originalsRetained += 1
                    } else {
                        result.failed += 1
                    }
                    continue
                }

                let coordinator = NSFileCoordinator()
                if Self.isSameVolume(source, root),
                   let movedItem = Self.coordinateSameVolumeMove(
                       source: source, coordinator: coordinator,
                       pipeline: pipeline, context: context
                   )
                {
                    result.items.append(movedItem)
                    continue
                }
                var coordinationError: NSError?
                var item: TrayItem?
                coordinator.coordinate(
                    readingItemAt: source, options: [], error: &coordinationError
                ) { coordinatedURL in
                    item = try? pipeline.materialize(
                        .file(
                            coordinatedURL,
                            typeIdentifier: Self.inferredTypeIdentifier(for: coordinatedURL)
                        ),
                        context: context
                    )
                }
                guard coordinationError == nil, let item,
                      Self.verifyManaged(item: item, root: root)
                else {
                    if let item {
                        try? FileManager.default.removeItem(at: root.appendingPathComponent(
                            item.id.uuidString, isDirectory: true
                        ))
                    }
                    result.failed += 1
                    continue
                }

                var deletionError: NSError?
                var removed = false
                coordinator.coordinate(
                    writingItemAt: source, options: .forDeleting, error: &deletionError
                ) { coordinatedURL in
                    do {
                        try FileManager.default.removeItem(at: coordinatedURL)
                        removed = true
                    } catch {
                        removed = false
                    }
                }
                result.items.append(item)
                if !removed || deletionError != nil {
                    result.originalsRetained += 1
                }
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.add(result.items, failedCount: result.failed)
                if result.originalsRetained > 0 {
                    self.activities.peek(
                        title: "Copied; Original Retained",
                        message: "\(result.originalsRetained) source item(s) could not be removed",
                        symbol: "exclamationmark.triangle.fill", tint: .warning
                    )
                } else if !result.items.isEmpty {
                    self.activities.peek(
                        title: "Moved to \(self.activeCollection.name)",
                        message: result.items.count == 1 ? result.items[0].displayName : "\(result.items.count) items",
                        symbol: "tray.and.arrow.down.fill", tint: .success
                    )
                }
            }
        }
        return true
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
        expiryTask?.cancel()
        let now = Date()
        let expired = items.filter {
            !$0.isPinned && $0.expiresAt.map { $0 <= now } == true
        }
        guard !expired.isEmpty else {
            scheduleNearestExpiry()
            return
        }
        let expiredIDs = Set(expired.map(\.id))
        quickLook.closeIfContains(expiredIDs)
        deletePayloads(for: expired) { [weak self] deletedIDs, failedIDs in
            guard let self else { return }
            self.items.removeAll { deletedIDs.contains($0.id) }
            for index in self.items.indices where failedIDs.contains(self.items[index].id) {
                self.items[index].cleanupError = true
            }
            self.persist()
            self.scheduleNearestExpiry()
        }
    }

    private func scheduleNearestExpiry() {
        expiryTask?.cancel()
        guard let deadline = TrayExpiryPolicy.nearestDeadline(in: items, after: Date()) else {
            expiryTask = nil
            return
        }
        let delay = max(deadline.timeIntervalSinceNow, 0)
        expiryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.pruneExpired()
        }
    }

    private func deletePayloads(
        for selected: [TrayItem],
        completion: @escaping @MainActor @Sendable (Set<UUID>, Set<UUID>) -> Void
    ) {
        let root = storageRoot
        DispatchQueue.global(qos: .utility).async {
            var deleted = Set<UUID>()
            var failed = Set<UUID>()
            for item in selected {
                let folder = root.appendingPathComponent(item.id.uuidString, isDirectory: true)
                do {
                    if FileManager.default.fileExists(atPath: folder.path) {
                        try FileManager.default.removeItem(at: folder)
                    }
                    deleted.insert(item.id)
                } catch {
                    failed.insert(item.id)
                }
            }
            Task { @MainActor in completion(deleted, failed) }
        }
    }

    private func ingestionContext(collectionID: UUID) -> TrayIngestionContext {
        let addedAt = Date()
        let days = collections.first(where: { $0.id == collectionID })?
            .expiryDaysOverride ?? settings.tray.ttlDays
        return TrayIngestionContext(
            collectionID: collectionID,
            expiresAt: TrayExpiryPolicy.deadline(addedAt: addedAt, days: days),
            addedAt: addedAt
        )
    }

    /// Staged share copies are transient; clear any left over from a prior run.
    private func clearStaging() {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: shareStagingRoot, includingPropertiesForKeys: nil)
        else { return }
        for entry in entries {
            try? fm.removeItem(at: entry)
        }
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
            Task { @MainActor in self?.thumbnailGeneration += 1 }
        }
    }

    // MARK: - Off-main file work

    private nonisolated static func stageCopy(_ source: URL, root: URL) -> URL? {
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

    private nonisolated static func inferredTypeIdentifier(for url: URL) -> String {
        if let values = try? url.resourceValues(forKeys: [.contentTypeKey]),
           let type = values.contentType
        {
            return type.identifier
        }
        return UTType(filenameExtension: url.pathExtension)?.identifier
            ?? UTType.data.identifier
    }

    nonisolated static func moveEligibility(for source: URL) -> TrayMoveEligibility {
        let values = try? source.resourceValues(forKeys: [
            .volumeIsReadOnlyKey, .isUbiquitousItemKey,
            .ubiquitousItemDownloadingStatusKey,
        ])
        let descriptor = TrayMoveSourceDescriptor(
            isFileURL: source.isFileURL,
            isWritable: FileManager.default.isWritableFile(
                atPath: source.deletingLastPathComponent().path
            ),
            volumeIsReadOnly: values?.volumeIsReadOnly ?? true,
            isUbiquitous: values?.isUbiquitousItem ?? false,
            isDownloaded: values?.isUbiquitousItem != true
                || values?.ubiquitousItemDownloadingStatus == .current
        )
        return TrayMoveEligibility.evaluate(descriptor)
    }

    private nonisolated static func isSameVolume(_ source: URL, _ destinationRoot: URL) -> Bool {
        let sourceID = try? source.resourceValues(forKeys: [.volumeIdentifierKey]).volumeIdentifier
        let destinationID = try? destinationRoot.resourceValues(
            forKeys: [.volumeIdentifierKey]
        ).volumeIdentifier
        guard let sourceID, let destinationID else { return false }
        return String(describing: sourceID) == String(describing: destinationID)
    }

    private nonisolated static func coordinateSameVolumeMove(
        source: URL,
        coordinator: NSFileCoordinator,
        pipeline: TrayIngestionPipeline,
        context: TrayIngestionContext
    ) -> TrayItem? {
        var coordinationError: NSError?
        var item: TrayItem?
        coordinator.coordinate(
            writingItemAt: source, options: .forMoving, error: &coordinationError
        ) { coordinatedURL in
            item = try? pipeline.materializeMovingFile(
                coordinatedURL,
                typeIdentifier: inferredTypeIdentifier(for: coordinatedURL),
                context: context
            )
        }
        return coordinationError == nil ? item : nil
    }

    private nonisolated static func verifyManaged(item: TrayItem, root: URL) -> Bool {
        let url = item.url(relativeTo: root)
        guard FileManager.default.isReadableFile(atPath: url.path),
              let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
        else { return false }
        return values.isDirectory == true || Int64(values.fileSize ?? -1) == item.byteSize
    }

    private nonisolated static func webURL(from value: NSSecureCoding?) -> URL? {
        if let url = value as? URL {
            return url
        }
        if let string = value as? String {
            return URL(string: string)
        }
        if let data = value as? Data,
           let string = String(data: data, encoding: .utf8)
        {
            return URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    private nonisolated static func plainText(from value: NSSecureCoding?) -> String? {
        if let string = value as? String {
            return string
        }
        if let data = value as? Data {
            return String(data: data, encoding: .utf8)
        }
        if let url = value as? URL {
            return url.absoluteString
        }
        return nil
    }

    private nonisolated static func weblocData(for url: URL) -> Data? {
        try? PropertyListSerialization.data(
            fromPropertyList: ["URL": url.absoluteString],
            format: .xml, options: 0
        )
    }

    private nonisolated static func pngData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    private nonisolated static func renameTransaction(
        item: TrayItem,
        to name: String,
        root: URL
    ) -> TrayRenameTransactionResult {
        let oldURL = item.url(relativeTo: root)
        let newURL = oldURL.deletingLastPathComponent().appendingPathComponent(name)
        let oldThumbnail = item.thumbnailURL(relativeTo: root)
        let newThumbnail = newURL.deletingPathExtension().appendingPathExtension("thumbnail.png")
        guard !FileManager.default.fileExists(atPath: newURL.path) else { return .failure }
        do {
            try FileManager.default.moveItem(at: oldURL, to: newURL)
            if FileManager.default.fileExists(atPath: oldThumbnail.path),
               oldThumbnail != newThumbnail
            {
                do {
                    if FileManager.default.fileExists(atPath: newThumbnail.path) {
                        try FileManager.default.removeItem(at: newThumbnail)
                    }
                    try FileManager.default.moveItem(at: oldThumbnail, to: newThumbnail)
                } catch {
                    try? FileManager.default.moveItem(at: newURL, to: oldURL)
                    return .failure
                }
            }
            return .success("\(item.id.uuidString)/\(name)")
        } catch {
            return .failure
        }
    }

    private nonisolated static func makeArchiveWorkspace(
        urls: [URL],
        stagingRoot: URL
    ) -> TrayArchiveWorkspace? {
        let folder = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let archive = folder.appendingPathComponent("Archive.zip")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let source: URL
            if urls.count == 1, let only = urls.first {
                source = only
            } else {
                let contents = folder.appendingPathComponent("Items", isDirectory: true)
                try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
                var existing = Set<String>()
                for url in urls {
                    guard let name = TrayFileNamePolicy.availableName(
                        url.lastPathComponent, existing: existing
                    ) else { continue }
                    try FileManager.default.copyItem(
                        at: url, to: contents.appendingPathComponent(name)
                    )
                    existing.insert(name)
                }
                source = contents
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
            process.arguments = [
                "-c", "-k", "--sequesterRsrc", "--keepParent",
                source.path, archive.path,
            ]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  FileManager.default.isReadableFile(atPath: archive.path)
            else {
                try? FileManager.default.removeItem(at: folder)
                return nil
            }
            return TrayArchiveWorkspace(folder: folder, archive: archive)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            return nil
        }
    }

    private nonisolated static func makeThumbnail(
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

private enum TrayRenameTransactionResult: Sendable {
    case success(String)
    case failure
}

private struct TrayArchiveWorkspace: Sendable {
    let folder: URL
    let archive: URL
}

private struct TrayMoveBatchResult: Sendable {
    var items: [TrayItem] = []
    var originalsRetained = 0
    var failed = 0
}

private struct TrayProviderIngestionResult: Sendable {
    let items: [TrayItem]
    let failedCount: Int
}

private final class TrayProviderIngestionBatch: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: Int
    private var items: [TrayItem] = []
    private var failedCount = 0
    private let completion: @Sendable (TrayProviderIngestionResult) -> Void

    init(
        expectedCount: Int,
        completion: @escaping @Sendable (TrayProviderIngestionResult) -> Void
    ) {
        self.remaining = expectedCount
        self.completion = completion
    }

    func finish(_ item: TrayItem?) {
        lock.lock()
        if let item {
            items.append(item)
        } else {
            failedCount += 1
        }
        remaining -= 1
        let result = remaining == 0
            ? TrayProviderIngestionResult(items: items, failedCount: failedCount)
            : nil
        lock.unlock()
        if let result {
            completion(result)
        }
    }
}

private final class ShareItemAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Any] = []

    func append(_ item: Any) {
        lock.lock()
        storage.append(item)
        lock.unlock()
    }

    var values: [Any] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
