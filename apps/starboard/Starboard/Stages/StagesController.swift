import AppKit
import StarboardCore
import SwiftUI

/// Stages are saved workspaces. Leader then `=` saves the visible apps,
/// leader then a letter restores a Stage, and leader then `-` closes the
/// windows of the Stage restored last.
@MainActor
final class StagesController {
    private let registry: AppRegistry
    private let config: ConfigStore
    private let windows: WindowService
    private let toast: ToastHUD
    private var saveWindow: NSWindow?
    private var activeLetter: Character?

    init(registry: AppRegistry, config: ConfigStore, windows: WindowService, toast: ToastHUD) {
        self.registry = registry
        self.config = config
        self.windows = windows
        self.toast = toast
    }

    func beginSave() async {
        let apps = await visibleApps()
        // The sheet has no close button, so a second save replaces it.
        closeSaveWindow()
        guard !apps.isEmpty else {
            toast.show(message: "No visible apps to save")
            return
        }

        let view = StageSaveView(
            apps: apps,
            takenLetters: config.config.stageLetters,
            onSave: { [weak self] name, letter, chosen in
                self?.save(name: name, letter: letter, apps: chosen)
                self?.closeSaveWindow()
            },
            onCancel: { [weak self] in self?.closeSaveWindow() }
        )
        saveWindow = showWindow(view, size: NSSize(width: 380, height: 100))
    }

    func restore(_ letter: Character) {
        guard let stage = config.config.stage(letter) else {
            toast.show(message: "No Stage on \(letter.uppercased())")
            return
        }
        let members = members(of: stage)
        // With every app already running this only hides the others again;
        // the files and URLs open when something had to be launched.
        let opensItems = members.contains { registry.runningApp($0.bundleID) == nil }
        let lead = members.first?.bundleID
        var leadLaunching = false
        for member in members {
            if let app = registry.runningApp(member.bundleID) {
                app.unhide()
            } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: member.bundleID) {
                let isLead = member.bundleID == lead
                leadLaunching = leadLaunching || isLead
                NSWorkspace.shared.openApplication(at: url, configuration: .init()) { app, _ in
                    // The first app ends up in front. A launching one can only
                    // be activated once it runs.
                    guard isLead, let app else { return }
                    Task { @MainActor in app.activateReliably() }
                }
            }
            if opensItems {
                member.open.forEach(open)
            }
        }

        let memberIDs = Set(members.map(\.bundleID))
        for app in registry.running where !memberIDs.contains(app.bundleIdentifier ?? "") {
            app.hide()
        }
        if !leadLaunching, let lead {
            registry.runningApp(lead)?.activateReliably()
        }
        activeLetter = letter
    }

    func closeActive() {
        guard let activeLetter, let stage = config.config.stage(activeLetter) else { return }
        for member in members(of: stage) {
            if let app = registry.runningApp(member.bundleID) {
                windows.closeAllWindows(of: app.processIdentifier)
            }
        }
        self.activeLetter = nil
        toast.show(message: "Closed \(stage.displayName)")
    }

    /// The Stage's apps that are installed, with the items each opens.
    private func members(of stage: Stage) -> [(bundleID: String, open: [String])] {
        let records = registry.records(naming: stage.apps.map(\.app))
        return stage.apps.compactMap { member in
            Config.bundleID(for: member.app, in: records).map { ($0, member.open) }
        }
    }

    /// Apps with a window on the current Space, front to back.
    private func visibleApps() async -> [AppCandidate] {
        var seen = Set<String>()
        return await windows.visibleWindows().compactMap { window in
            guard let app = NSRunningApplication(processIdentifier: window.pid),
                  app.activationPolicy == .regular,
                  let bundleID = app.bundleIdentifier, let name = app.localizedName,
                  seen.insert(bundleID).inserted else { return nil }
            return AppCandidate(bundleID: bundleID, name: name)
        }
    }

    private func save(name: String, letter: Character, apps: [AppCandidate]) {
        let members = apps.map { StageApp(app: registry.reference(bundleID: $0.bundleID, name: $0.name)) }
        let stage = Stage(letter: String(letter), name: name, apps: members)
        // A letter names one Stage; saving to a taken letter replaces it.
        let saved = config.update { config in
            config.stages.removeAll { Config.letter($0.letter) == letter }
            config.stages.append(stage)
        }
        if case let .failure(error) = saved {
            toast.show(message: "Stage not saved: \(error.message)")
            return
        }
        activeLetter = letter
        toast.show(message: "Saved \(stage.displayName). Leader, then \(letter.uppercased()) restores it")
    }

    private func closeSaveWindow() {
        saveWindow?.close()
        saveWindow = nil
    }

    private func open(_ item: String) {
        if item.hasPrefix("http://") || item.hasPrefix("https://"), let url = URL(string: item) {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: (item as NSString).expandingTildeInPath))
        }
    }
}
