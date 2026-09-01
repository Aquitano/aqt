import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    let env = AppEnvironment()

    private var windowController: NotchWindowController!
    private var statusItem: NSStatusItem!
    private var onboardingWindow: NSWindow?
    private let hotKey = HotKey()
    private var hotkeyObserver: Task<Void, Never>?
    private var trayMenuObserver: Task<Void, Never>?
    private var clearTrayMenuItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        windowController = NotchWindowController(env: env)
        env.windowController = windowController

        setupStatusItem()
        env.start()
        env.notch.showCompact()

        NotificationCenter.default.addObserver(
            self, selector: #selector(showOnboarding), name: .showOnboarding, object: nil
        )
        setupHotkey()
        if !env.settings.general.hasCompletedOnboarding {
            showOnboarding()
        }

        Log.app.info("Notch launched")
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        windowController?.stop()
        env.agents.stop()
        env.screenshots.stop()
        env.persistence.flush()
    }

    // MARK: - Hotkey

    private func setupHotkey() {
        hotKey.onPress = { [weak self] in self?.toggleNotch() }
        // Re-register whenever the chord changes, and suspend while the Settings
        // recorder is capturing so the current chord can be re-typed without
        // toggling the notch mid-recording.
        let settings = env.settings
        hotkeyObserver = watch({
            (settings.general.hotkeyEnabled, settings.general.hotkeyKeyCode, settings.general.hotkeyModifiers, settings.isRecordingHotkey)
        }) { [weak self] enabled, keyCode, modifiers, recording in
            guard let self else { return }
            if enabled, !recording {
                self.hotKey.register(keyCode: UInt32(keyCode), modifiers: UInt32(modifiers))
            } else {
                self.hotKey.unregister()
            }
        }
    }

    // MARK: - Onboarding

    /// First-run welcome tour; also reachable from Settings via `.showOnboarding`.
    @objc private func showOnboarding() {
        if onboardingWindow == nil {
            let root = OnboardingView { [weak self] in
                self?.onboardingWindow?.close()
            }
            .injectNotchEnvironment(env)

            let window = NSWindow(contentViewController: NSHostingController(rootView: root))
            window.styleMask = [.titled, .closable, .fullSizeContentView]
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.title = "Welcome to Notch"
            // Closing only hides it; keep the instance so the tour can reopen.
            window.isReleasedWhenClosed = false
            window.center()
            onboardingWindow = window
        }
        onboardingWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Status item

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = PixelIconImage.image(systemName: "rectangle.tophalf.inset.filled")
        }

        let menu = NSMenu()
        addItem(to: menu, title: "Toggle Notch", action: #selector(toggleNotch))
        let clearTrayItem = NSMenuItem(title: "Clear Tray (0)", action: #selector(clearTray), keyEquivalent: "")
        clearTrayItem.target = self
        menu.addItem(clearTrayItem)
        clearTrayMenuItem = clearTrayItem
        let tray = env.tray
        trayMenuObserver = watch({ tray.items.count }) { [weak self] count in
            self?.clearTrayMenuItem?.title = "Clear Tray (\(count))"
            self?.clearTrayMenuItem?.isEnabled = count > 0
        }

        let timerItem = NSMenuItem(title: "Start Timer", action: nil, keyEquivalent: "")
        let timerMenu = NSMenu()
        for minutes in [1, 5, 10, 25] {
            let item = NSMenuItem(title: "\(minutes) min", action: #selector(startTimer(_:)), keyEquivalent: "")
            item.target = self
            item.tag = minutes
            timerMenu.addItem(item)
        }
        timerItem.submenu = timerMenu
        menu.addItem(timerItem)
        addItem(to: menu, title: "Cancel Timer", action: #selector(cancelTimer))

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
        env.notch.toggle()
    }

    @objc private func clearTray() {
        env.tray.clear()
    }

    @objc private func startTimer(_ sender: NSMenuItem) {
        env.timer.start(name: "Timer", duration: TimeInterval(sender.tag * 60))
    }

    @objc private func cancelTimer() {
        env.timer.cancel()
    }

    @objc private func openSettings() {
        env.notch.collapseImmediately()
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

extension Notification.Name {
    /// Present the welcome tour (posted by Settings; AppDelegate owns the window).
    static let showOnboarding = Notification.Name("app.notch.showOnboarding")
}
