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

    let storageRoot: URL
    /// Temp copies for share-on-drop, kept out of the shelf and wiped each launch.
    let shareStagingRoot: URL
    private let persistence: Persistence
    private let imageCache: ImageCache
    private let settings: Settings
    private unowned let activities: ActivityManager
    private let storeFile = "tray.json"
    private var cancellables = Set<AnyCancellable>()

    init(persistence: Persistence, imageCache: ImageCache, settings: Settings, activities: ActivityManager) {
        self.persistence = persistence
        self.imageCache = imageCache
        self.settings = settings
        self.activities = activities
        self.storageRoot = persistence.directory(named: "CopiedItems")
        self.shareStagingRoot = persistence.directory(named: "ShareStaging")
        self.items = persistence.load([DropItem].self, from: storeFile) ?? []
    }

    func start() {
        pruneExpired()
        clearStaging()
        preloadThumbnails()

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

        provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, error in
            guard let self, let url else {
                if let error { Log.tray.error("Drop failed: \(error.localizedDescription)") }
                return
            }
            // Copy bytes out synchronously; `url` dies when this handler returns.
            guard let item = Self.copyIntoStorage(url, root: self.storageRoot, typeIdentifier: typeIdentifier) else { return }
            // Add immediately — the shelf entry and "Added to Shelf" peek shouldn't
            // wait on thumbnailing. The thumbnail reads the persisted copy, not the
            // dying drag URL, so it can finish whenever; nudge the shelf to re-read
            // when it lands.
            Task { @MainActor [weak self] in self?.add(item) }
            Self.makeThumbnail(for: item, root: self.storageRoot) { [weak self] image in
                Task { @MainActor in
                    guard let self else { return }
                    if let image { self.imageCache.store(image, forKey: self.thumbnailKey(for: item)) }
                    self.objectWillChange.send()
                }
            }
        }
    }

    private func add(_ item: DropItem) {
        items.insert(item, at: 0)
        persist()
        activities.peek(title: "Added to Shelf", message: item.fileName,
                        symbol: "tray.and.arrow.down.fill", tint: .success)
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
        persistence.save(items, to: storeFile)
    }

    private func pruneExpired() {
        guard settings.trayTTLDays > 0 else { return }
        let cutoff = Date().addingTimeInterval(-Double(settings.trayTTLDays) * 86_400)
        let expired = items.filter { $0.addedAt < cutoff }
        guard !expired.isEmpty else { return }
        let expiredIDs = Set(expired.map(\.id))
        for item in expired {
            let folder = storageRoot.appendingPathComponent(item.id.uuidString, isDirectory: true)
            try? FileManager.default.removeItem(at: folder)
        }
        items.removeAll { expiredIDs.contains($0.id) }
        persist()
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

    nonisolated private static func copyIntoStorage(_ source: URL, root: URL, typeIdentifier: String) -> DropItem? {
        let id = UUID()
        let folder = root.appendingPathComponent(id.uuidString, isDirectory: true)
        let fileName = source.lastPathComponent
        let destination = folder.appendingPathComponent(fileName)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: destination)
            let size = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return DropItem(
                id: id,
                fileName: fileName,
                relativePath: "\(id.uuidString)/\(fileName)",
                byteSize: Int64(size),
                addedAt: Date(),
                typeIdentifier: typeIdentifier
            )
        } catch {
            Log.tray.error("Copy into storage failed: \(error.localizedDescription)")
            return nil
        }
    }

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
