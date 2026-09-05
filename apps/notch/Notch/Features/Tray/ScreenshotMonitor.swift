import AppKit
import NotchCore
import UniformTypeIdentifiers

@MainActor
@Observable
final class ScreenshotMonitor {
    private(set) var candidates: [ScreenshotCandidate] = []

    private let settings: Settings
    private let activities: ActivityManager
    private let tray: TrayManager
    private var source: DispatchSourceFileSystemObject?
    private var directoryHandle: Int32 = -1
    private var knownPaths = Set<String>()
    private var dismissedIDs = Set<String>()
    private var pendingTasks: [String: Task<Void, Never>] = [:]
    private var settingsObserver: Task<Void, Never>?
    private var monitoringStartedAt = Date()

    init(settings: Settings, activities: ActivityManager, tray: TrayManager) {
        self.settings = settings
        self.activities = activities
        self.tray = tray
    }

    func start() {
        settingsObserver = watch({ [settings] in settings.tray.offerScreenshots }) { [weak self] enabled in
            enabled ? self?.beginMonitoring() : self?.stop()
        }
    }

    func stop() {
        if let source {
            source.cancel()
            self.source = nil
            directoryHandle = -1
        } else if directoryHandle >= 0 {
            close(directoryHandle)
            directoryHandle = -1
        }
        pendingTasks.values.forEach { $0.cancel() }
        pendingTasks.removeAll()
        candidates.removeAll()
        activities.remove(channel: .screenshots)
    }

    func addAllToShelf() {
        let current = candidates.filter { FileManager.default.fileExists(atPath: $0.url.path) }
        guard !current.isEmpty else { dismissAll(); return }
        tray.ingest(current.map { .file($0.url, typeIdentifier: UTType.image.identifier) })
        dismiss(ids: Set(current.map(\.id)))
    }

    func dismissAll() {
        dismiss(ids: Set(candidates.map(\.id)))
    }

    func previewAll(onClose: @escaping () -> Void) {
        let urls = candidates.map(\.url).filter { FileManager.default.fileExists(atPath: $0.path) }
        tray.quickLook.present(urls: urls, onClose: onClose)
    }

    private func dismiss(ids: Set<String>) {
        dismissedIDs.formUnion(ids)
        candidates.removeAll { ids.contains($0.id) }
        publishActivity()
    }

    private func beginMonitoring() {
        stop()
        guard settings.tray.offerScreenshots else { return }
        let directory = Self.screenshotDirectory()
        monitoringStartedAt = Date()
        knownPaths = Set(Self.directoryEntries(directory).map(\.path))
        let handle = open(directory.path, O_EVTONLY)
        guard handle >= 0 else { return }
        directoryHandle = handle
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: handle,
            eventMask: [.write, .rename, .delete],
            queue: .global(qos: .utility)
        )
        source.setEventHandler { [weak self] in
            let entries = Self.directoryEntries(directory)
            Task { @MainActor [weak self] in self?.handle(entries: entries) }
        }
        source.setCancelHandler { close(handle) }
        self.source = source
        source.resume()
    }

    private func handle(entries: [URL]) {
        let paths = Set(entries.map(\.path))
        let newURLs = entries.filter { !knownPaths.contains($0.path) }
        knownPaths = paths
        for url in newURLs {
            scheduleStableRead(for: url)
        }
    }

    private func scheduleStableRead(for url: URL) {
        pendingTasks[url.path]?.cancel()
        let startedAt = monitoringStartedAt
        pendingTasks[url.path] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let first = Self.descriptor(for: url) else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled, let second = Self.descriptor(for: url),
                  first.fileSize == second.fileSize,
                  let candidate = ScreenshotCandidatePolicy.candidate(
                      from: second, monitoringStartedAt: startedAt, now: Date()
                  ) else { return }
            self?.accept(candidate)
        }
    }

    private func accept(_ candidate: ScreenshotCandidate) {
        pendingTasks[candidate.url.path] = nil
        guard !dismissedIDs.contains(candidate.id),
              !candidates.contains(where: { $0.id == candidate.id }) else { return }
        candidates.append(candidate)
        candidates.sort { $0.createdAt < $1.createdAt }
        publishActivity()
    }

    private func publishActivity() {
        if candidates.isEmpty {
            activities.remove(channel: .screenshots)
        } else {
            activities.publish(Activity(
                kind: .screenshotCandidates(candidates), priority: .high,
                createdAt: Date(), ttl: 30
            ))
        }
    }

    private nonisolated static func screenshotDirectory() -> URL {
        let defaults = UserDefaults(suiteName: "com.apple.screencapture")
        if let raw = defaults?.string(forKey: "location"), !raw.isEmpty {
            return URL(fileURLWithPath: NSString(string: raw).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0]
    }

    private nonisolated static func directoryEntries(_ directory: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants]
        )) ?? []
    }

    private nonisolated static func descriptor(for url: URL) -> ScreenshotFileDescriptor? {
        let keys: Set<URLResourceKey> = [
            .contentTypeKey, .creationDateKey, .fileSizeKey,
            .fileResourceIdentifierKey, .isReadableKey, .isRegularFileKey,
        ]
        guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else {
            return nil
        }
        let name = url.deletingPathExtension().lastPathComponent.folding(
            options: [.caseInsensitive, .diacriticInsensitive], locale: .current
        )
        let markers = ["screenshot", "screen shot", "bildschirmfoto", "captura de pantalla", "captura de ecra"]
        return ScreenshotFileDescriptor(
            url: url,
            resourceIdentifier: values.fileResourceIdentifier.map { String(describing: $0) },
            createdAt: values.creationDate,
            fileSize: values.fileSize,
            isImage: values.contentType?.conforms(to: .image) == true,
            hasScreenshotEvidence: markers.contains { name.contains($0) },
            isReadable: values.isReadable == true
        )
    }
}
