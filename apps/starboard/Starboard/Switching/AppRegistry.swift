import AppKit
import Combine
import StarboardCore

/// Running apps, most recently used first, and the apps installed in the
/// usual folders.
@MainActor
final class AppRegistry {
    /// The frontmost app first, then by last activation, then never-activated
    /// apps by launch date.
    private(set) var running: [NSRunningApplication] = []
    /// `running` as the letter rules see it, in the same order.
    private(set) var candidates: [AppCandidate] = []
    private(set) var installed: [AppRecord] = []
    var onInstalledChange: (() -> Void)?

    private var lastActivated: [String: Date] = [:]
    private var installedScannedAt: ContinuousClock.Instant?
    private var scanning = false
    private var cancellables = Set<AnyCancellable>()

    init() {
        NSWorkspace.shared.publisher(for: \.runningApplications)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshRunning() }
            .store(in: &cancellables)
        NSWorkspace.shared.notificationCenter
            .publisher(for: NSWorkspace.didActivateApplicationNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                if let bundleID = app?.bundleIdentifier {
                    self?.lastActivated[bundleID] = Date()
                }
                self?.refreshRunning()
            }
            .store(in: &cancellables)
        refreshRunning()
        refreshInstalled()
    }

    var hasScannedInstalled: Bool {
        installedScannedAt != nil
    }

    /// The apps `names` may refer to: running apps by display name, installed
    /// ones by display name, bundle name and file name, and any of `names`
    /// that is a bundle ID LaunchServices knows outside the scanned folders,
    /// such as a Chrome web app.
    func records(naming names: [String]) -> [AppRecord] {
        var records = running.compactMap { app in
            app.bundleIdentifier.map { AppRecord(bundleID: $0, names: app.localizedName.map { [$0] } ?? []) }
        } + installed
        for name in names {
            guard Config.bundleID(for: name, in: records) == nil,
                  NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) != nil else { continue }
            records.append(AppRecord(bundleID: name, names: []))
        }
        return records
    }

    /// How the config should name an app: by its name when that finds it
    /// among the installed apps while it is closed, by bundle ID otherwise.
    func reference(bundleID: String, name: String) -> String {
        Config.bundleID(for: name, in: installed) == bundleID ? name : bundleID
    }

    func runningApp(_ bundleID: String) -> NSRunningApplication? {
        running.first { $0.bundleIdentifier == bundleID }
    }

    /// Rescans the app folders off the main thread unless a scan finished
    /// in the last 30 seconds, so apps installed since show up.
    func refreshInstalled() {
        if scanning || installedScannedAt.map({ .now - $0 < .seconds(30) }) == true {
            return
        }
        scanning = true
        Task {
            let apps = await Task.detached(priority: .utility) {
                signposter.withIntervalSignpost("Installed app scan") { Self.scanInstalledApps() }
            }.value
            let changed = apps != installed
            installed = apps
            installedScannedAt = .now
            scanning = false
            if changed {
                onInstalledChange?()
            }
        }
    }

    /// Each `launchDate` read costs about two microseconds, so the dates are
    /// read once per change here rather than on every comparison or keystroke.
    private func refreshRunning() {
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { app in (
                app: app,
                activated: app.bundleIdentifier.flatMap { lastActivated[$0] },
                launched: app.launchDate
            ) }
            .sorted { left, right in
                if left.app.isActive != right.app.isActive {
                    return left.app.isActive
                }
                switch (left.activated, right.activated) {
                case let (.some(leftDate), .some(rightDate)): return leftDate > rightDate
                case (.some, .none): return true
                case (.none, .some): return false
                case (.none, .none): return (left.launched ?? .distantPast) > (right.launched ?? .distantPast)
                }
            }
        running = apps.map(\.app)
        candidates = apps.compactMap { app, _, launched in
            guard let bundleID = app.bundleIdentifier, let name = app.localizedName else { return nil }
            return AppCandidate(bundleID: bundleID, name: name, launchedAt: launched)
        }
    }

    /// Every app the overlay may show an icon for.
    var bundleIDs: [String] {
        candidates.map(\.bundleID) + installed.map(\.bundleID)
    }

    private nonisolated static func scanInstalledApps() -> [AppRecord] {
        let folders = [
            "/Applications",
            "/Applications/Utilities",
            "/System/Applications",
            "/System/Applications/Utilities",
            NSString("~/Applications").expandingTildeInPath,
        ]
        var seen = Set<String>()
        var records: [AppRecord] = []
        for folder in folders {
            let urls = (try? FileManager.default.contentsOfDirectory(
                at: URL(fileURLWithPath: folder),
                includingPropertiesForKeys: nil
            )) ?? []
            for url in urls where url.pathExtension == "app" {
                guard let bundle = Bundle(url: url),
                      let bundleID = bundle.bundleIdentifier,
                      seen.insert(bundleID).inserted else { continue }
                let names = [
                    bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
                    bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String,
                    url.deletingPathExtension().lastPathComponent,
                ]
                var unique: [String] = []
                for case let name? in names where !name.isEmpty && !unique.contains(name) {
                    unique.append(name)
                }
                records.append(AppRecord(bundleID: bundleID, names: unique))
            }
        }
        return records
    }
}

extension AppRecord {
    var name: String {
        names.first ?? bundleID
    }
}
