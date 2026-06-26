import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    let env = AppEnvironment()

    private var windowController: NotchWindowController!
    private var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        windowController = NotchWindowController(env: env)
        env.windowController = windowController

        setupStatusItem()
        env.start()
        env.state.showCompact()

        Log.app.info("Notch launched")
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: - Status item

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "rectangle.tophalf.inset.filled",
                                   accessibilityDescription: "Notch")
            button.image?.isTemplate = true
        }

        let menu = NSMenu()
        addItem(to: menu, title: "Toggle Notch", action: #selector(toggleNotch))
        addItem(to: menu, title: "Clear Tray", action: #selector(clearTray))
        menu.addItem(.separator())
        addItem(to: menu, title: "Settings…", action: #selector(openSettings), key: ",")
        menu.addItem(.separator())
        addItem(to: menu, title: "Quit Notch", action: #selector(quit), key: "q")
        statusItem.menu = menu
    }

    private func addItem(to menu: NSMenu, title: String, action: Selector, key: String = "") {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
    }

    @objc private func toggleNotch() {
        if env.state.isVisible {
            env.state.hide()
        } else {
            env.state.expand()
        }
    }

    @objc private func clearTray() {
        env.tray.clear()
    }

    @objc private func openSettings() {
        NSApp.activate(ignoringOtherApps: true)
        // macOS 14+ selector; fall back to the legacy one just in case.
        if !NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) {
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
