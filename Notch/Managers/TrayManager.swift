import AppKit
import SwiftUI
import UniformTypeIdentifiers
import QuickLookThumbnailing

/// The file shelf. Copies dropped bytes into app storage immediately (drag temp
/// URLs are short-lived), snapshots a Quick Look thumbnail, and persists the list
/// across launches. Not sandboxed, so plain file URLs — no security-scoped bookmarks.
@MainActor
final class TrayManager: ObservableObject {

    @Published private(set) var items: [DropItem] = []

    let storageRoot: URL
    private let persistence: Persistence
    private let imageCache: ImageCache
    private let settings: Settings
    private let storeFile = "tray.json"

    init(persistence: Persistence, imageCache: ImageCache, settings: Settings) {
        self.persistence = persistence
        self.imageCache = imageCache
        self.settings = settings
        self.storageRoot = persistence.directory(named: "CopiedItems")
        self.items = persistence.load([DropItem].self, from: storeFile) ?? []
    }

    func start() {
        pruneExpired()
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
            Self.makeThumbnail(for: item, root: self.storageRoot)
            Task { @MainActor [weak self] in self?.add(item) }
        }
    }

    private func add(_ item: DropItem) {
        items.insert(item, at: 0)
        persist()
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
        let key = "tray.\(item.id.uuidString)"
        if let cached = imageCache.image(forKey: key) { return cached }
        let url = item.thumbnailURL(relativeTo: storageRoot)
        guard let data = try? Data(contentsOf: url),
              let image = imageCache.downsample(data: data, maxDimension: 160) else { return nil }
        imageCache.store(image, forKey: key)
        return image
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
        for item in expired { remove(item) }
    }

    // MARK: - Off-main file work

    private static func copyIntoStorage(_ source: URL, root: URL, typeIdentifier: String) -> DropItem? {
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

    private static func makeThumbnail(for item: DropItem, root: URL) {
        let fileURL = item.url(relativeTo: root)
        let request = QLThumbnailGenerator.Request(
            fileAt: fileURL,
            size: CGSize(width: 320, height: 320),
            scale: 2,
            representationTypes: .all
        )
        let semaphore = DispatchSemaphore(value: 0)
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, _ in
            defer { semaphore.signal() }
            guard let cg = representation?.cgImage else { return }
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let data = rep.representation(using: .png, properties: [:]) else { return }
            try? data.write(to: item.thumbnailURL(relativeTo: root), options: .atomic)
        }
        _ = semaphore.wait(timeout: .now() + 3)
    }
}
