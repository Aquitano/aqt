import AppKit
import Combine

/// Running apps with regular activation policy, ordered most-recently-activated
/// first. Stays live via workspace observation — callers never poll.
@MainActor
final class AppRegistry {
    /// MRU order: frontmost app first, then by last activation, never-activated
    /// last (by launch date). Cycle order for conflicting letters derives from this.
    private(set) var runningApps: [NSRunningApplication] = []

    private var lastActivated: [String: Date] = [:]
    private var installedIndex: [AppCandidate]?
    private var cancellables = Set<AnyCancellable>()

    init() {
        NSWorkspace.shared.publisher(for: \.runningApplications)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refresh() }
            .store(in: &cancellables)

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                        as? NSRunningApplication,
                      let id = app.bundleIdentifier else { return }
                self?.lastActivated[id] = Date()
                self?.refresh()
            }
        }

        refresh()
    }

    func refresh() {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        runningApps = apps.sorted { a, b in
            if a.isActive != b.isActive { return a.isActive }
            let ia = a.bundleIdentifier.flatMap { lastActivated[$0] }
            let ib = b.bundleIdentifier.flatMap { lastActivated[$0] }
            switch (ia, ib) {
            case let (.some(x), .some(y)): return x > y
            case (.some, .none): return true
            case (.none, .some): return false
            case (.none, .none): return (a.launchDate ?? .distantPast) > (b.launchDate ?? .distantPast)
            }
        }
    }

    /// Installed-but-maybe-not-running apps, built lazily off-main and cached.
    /// Lets dynamic letters launch closed apps (BATTLEPLAN §3.4).
    func installedApps(completion: @escaping @MainActor ([AppCandidate]) -> Void) {
        if let installedIndex {
            completion(installedIndex)
            return
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let candidates = Self.scanInstalledApps()
            Task { @MainActor [weak self] in
                self?.installedIndex = candidates
                completion(candidates)
            }
        }
    }

    private nonisolated static func scanInstalledApps() -> [AppCandidate] {
        let directories = [
            "/Applications",
            "/Applications/Utilities",
            "/System/Applications",
            "/System/Applications/Utilities",
            NSString("~/Applications").expandingTildeInPath,
        ]
        var seen = Set<String>()
        var result: [AppCandidate] = []
        for directory in directories {
            let urls = (try? FileManager.default.contentsOfDirectory(
                at: URL(fileURLWithPath: directory),
                includingPropertiesForKeys: nil
            )) ?? []
            for url in urls where url.pathExtension == "app" {
                guard let bundle = Bundle(url: url),
                      let bundleID = bundle.bundleIdentifier,
                      seen.insert(bundleID).inserted else { continue }
                let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String)
                    ?? url.deletingPathExtension().lastPathComponent
                result.append(AppCandidate(bundleID: bundleID, name: name))
            }
        }
        return result
    }
}
