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
        guard !providers.isEmpty else { return false }
        let batch = TrayProviderIngestionBatch(expectedCount: providers.count) { [weak self] result in
            Task { @MainActor [weak self] in
                self?.add(result.items, failedCount: result.failedCount)
            }
        }
        for provider in providers { ingest(provider, batch: batch) }
        return true
    }

    private func ingest(_ provider: NSItemProvider, batch: TrayProviderIngestionBatch) {
        let identifiers = provider.registeredTypeIdentifiers
        guard let kind = TrayDropCapabilities.preferredKind(for: identifiers),
              let typeIdentifier = TrayDropCapabilities.preferredTypeIdentifier(
                for: kind, in: identifiers
              ) else {
            batch.finish(nil)
            return
        }
        let pipeline = ingestionPipeline
        let context = ingestionContext(collectionID: TrayCollection.shelfID)

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
                      let data = Self.weblocData(for: url) else {
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
        collectionID: UUID = TrayCollection.shelfID
    ) {
        guard !inputs.isEmpty else { return }
        let pipeline = ingestionPipeline
        let context = ingestionContext(collectionID: collectionID)
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
        var message = newItems.count == 1
            ? newItems[0].displayName
            : "\(newItems.count) items"
        if failedCount > 0 { message += " · \(failedCount) failed" }
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
                    if let url = Self.webURL(from: value) { staged.append(url) }
                }

            case .plainText:
                provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { value, _ in
                    defer { group.leave() }
                    if let text = Self.plainText(from: value) { staged.append(text) }
                }
            }
        }

        group.notify(queue: .main) {
            MainActor.assumeIsolated { completion(staged.values) }
        }
    }

    // MARK: - Mutation

    func remove(_ item: DropItem) {
        quickLook.closeIfContains([item.id])
        items.removeAll { $0.id == item.id }
        let folder = storageRoot.appendingPathComponent(item.id.uuidString, isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        persist()
    }

    func clear() {
        quickLook.closeIfContains(Set(items.map(\.id)))
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

    func items(withIDs ids: Set<UUID>) -> [TrayItem] {
        items.filter { ids.contains($0.id) }
    }

    func itemProvider(for item: TrayItem) -> NSItemProvider {
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
            case .text: return item.text
            case .url: return item.sourceURL
            case .file, .image: return nil
            }
        }
        guard !values.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(values.joined(separator: "\n"), forType: .string)
    }

    func setPinned(_ selected: [TrayItem], pinned: Bool) {
        guard !selected.isEmpty else { return }
        let ids = Set(selected.map(\.id))
        let newExpiry = pinned ? nil : ingestionContext(
            collectionID: selected[0].collectionID
        ).expiresAt
        for index in items.indices where ids.contains(items[index].id) {
            items[index].isPinned = pinned
            items[index].expiresAt = newExpiry
        }
        persist()
    }

    func remove(_ selected: [TrayItem]) {
        let ids = Set(selected.map(\.id))
        guard !ids.isEmpty else { return }
        quickLook.closeIfContains(ids)
        for item in selected {
            try? FileManager.default.removeItem(at: storageRoot.appendingPathComponent(
                item.id.uuidString, isDirectory: true
            ))
        }
        items.removeAll { ids.contains($0.id) }
        persist()
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
                case .success(let relativePath):
                    guard let index = self.items.firstIndex(where: { $0.id == item.id }) else { return }
                    self.items[index].displayName = name
                    self.items[index].relativePath = relativePath
                    self.persist()
                    self.objectWillChange.send()
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
        quickLook.closeIfContains(expiredIDs)
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

    nonisolated private static func inferredTypeIdentifier(for url: URL) -> String {
        if let values = try? url.resourceValues(forKeys: [.contentTypeKey]),
           let type = values.contentType {
            return type.identifier
        }
        return UTType(filenameExtension: url.pathExtension)?.identifier
            ?? UTType.data.identifier
    }

    nonisolated private static func webURL(from value: NSSecureCoding?) -> URL? {
        if let url = value as? URL { return url }
        if let string = value as? String { return URL(string: string) }
        if let data = value as? Data,
           let string = String(data: data, encoding: .utf8) {
            return URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    nonisolated private static func plainText(from value: NSSecureCoding?) -> String? {
        if let string = value as? String { return string }
        if let data = value as? Data { return String(data: data, encoding: .utf8) }
        if let url = value as? URL { return url.absoluteString }
        return nil
    }

    nonisolated private static func weblocData(for url: URL) -> Data? {
        try? PropertyListSerialization.data(
            fromPropertyList: ["URL": url.absoluteString],
            format: .xml, options: 0
        )
    }

    nonisolated private static func pngData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    nonisolated private static func renameTransaction(
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
               oldThumbnail != newThumbnail {
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

    nonisolated private static func makeArchiveWorkspace(
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
                source.path, archive.path
            ]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  FileManager.default.isReadableFile(atPath: archive.path) else {
                try? FileManager.default.removeItem(at: folder)
                return nil
            }
            return TrayArchiveWorkspace(folder: folder, archive: archive)
        } catch {
            try? FileManager.default.removeItem(at: folder)
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

private enum TrayRenameTransactionResult: Sendable {
    case success(String)
    case failure
}

private struct TrayArchiveWorkspace: Sendable {
    let folder: URL
    let archive: URL
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
        if let item { items.append(item) } else { failedCount += 1 }
        remaining -= 1
        let result = remaining == 0
            ? TrayProviderIngestionResult(items: items, failedCount: failedCount)
            : nil
        lock.unlock()
        if let result { completion(result) }
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
