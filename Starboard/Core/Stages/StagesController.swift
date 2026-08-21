import AppKit
import SwiftUI

/// Stages: saved workspaces (BATTLEPLAN §1.7). Leader+`=` snapshots the
/// visible apps, leader+letter restores (launching missing apps and opening
/// their configured items) or re-activates (hiding intruders again), and
/// leader+`-` closes the active Stage's windows. Main actor.
@MainActor
final class StagesController {
    private let settings: SettingsStore
    private var saveWindow: NSWindow?
    /// The most recently restored Stage — the target of leader+`-`.
    private var activeStageID: UUID?

    init(settings: SettingsStore) {
        self.settings = settings
    }

    // MARK: - Save

    func beginSave() {
        let captured = capturedApps()
        guard !captured.isEmpty else {
            ToastHUD.shared.show(message: "No visible apps to save")
            return
        }

        let takenLetters = Set(settings.model.stages.map(\.letter))
        let view = StageSaveView(
            apps: captured,
            takenLetters: takenLetters,
            onSave: { [weak self] name, letter, bundleIDs in
                self?.save(name: name, letter: letter, bundleIDs: bundleIDs, from: captured)
                self?.closeSaveWindow()
            },
            onCancel: { [weak self] in self?.closeSaveWindow() }
        )

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 100),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.center()
        saveWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func save(name: String, letter: Character, bundleIDs: Set<String>, from captured: [AppCandidate]) {
        let apps = captured
            .filter { bundleIDs.contains($0.bundleID) }
            .map { StageApp(bundleID: $0.bundleID) }
        guard !apps.isEmpty else { return }
        var stage = Stage(name: name, letter: String(letter).lowercased(), apps: apps)
        // A letter names exactly one Stage; saving to a taken letter replaces.
        settings.model.stages.removeAll { $0.letter == stage.letter }
        if stage.name.isEmpty { stage.name = "Stage \(stage.letter.uppercased())" }
        settings.model.stages.append(stage)
        activeStageID = stage.id
        ToastHUD.shared.show(message: "Saved \(stage.name) — leader+\(stage.letter.uppercased()) restores it")
    }

    private func closeSaveWindow() {
        saveWindow?.close()
        saveWindow = nil
    }

    /// Unique visible apps on the current Space, front-to-back.
    private func capturedApps() -> [AppCandidate] {
        var seen = Set<String>()
        return WindowEnumerator.visibleWindows().compactMap { window in
            guard let bundleID = window.bundleID, seen.insert(bundleID).inserted else {
                return nil
            }
            return AppCandidate(bundleID: bundleID, name: window.appName)
        }
    }

    // MARK: - Restore / activate

    func restore(letter: Character) {
        guard let stage = settings.model.stages.first(where: { $0.letter == String(letter).lowercased() }) else {
            ToastHUD.shared.show(message: "No Stage on \(String(letter).uppercased())")
            return
        }

        // All apps already running → this is an "activate": just re-hide
        // intruders. Otherwise a full restore that also opens the items.
        let fullRestore = !stage.apps.allSatisfy { runningApp($0.bundleID) != nil }

        for stageApp in stage.apps {
            if let app = runningApp(stageApp.bundleID) {
                app.unhide()
            } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: stageApp.bundleID) {
                NSWorkspace.shared.openApplication(at: url, configuration: .init())
            }
            if fullRestore {
                stageApp.openItems.forEach(openItem)
            }
        }

        let stageIDs = Set(stage.apps.map(\.bundleID))
        for app in NSWorkspace.shared.runningApplications
        where app.activationPolicy == .regular
            && !stageIDs.contains(app.bundleIdentifier ?? "") {
            app.hide()
        }

        if let first = stage.apps.first, let app = runningApp(first.bundleID) {
            app.activate()
        }
        activeStageID = stage.id
    }

    /// leader+`-`: close only the active Stage's windows (never terminate).
    func closeActive() {
        guard let activeStageID,
              let stage = settings.model.stages.first(where: { $0.id == activeStageID }) else {
            return
        }
        for stageApp in stage.apps {
            runningApp(stageApp.bundleID).map(AXWindowActions.closeAllWindows)
        }
        self.activeStageID = nil
        ToastHUD.shared.show(message: "Closed \(stage.name)")
    }

    // MARK: - Helpers

    private func runningApp(_ bundleID: String) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first
    }

    private func openItem(_ item: String) {
        if item.hasPrefix("http://") || item.hasPrefix("https://") {
            URL(string: item).map { NSWorkspace.shared.open($0) }
        } else {
            let path = (item as NSString).expandingTildeInPath
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }
}
