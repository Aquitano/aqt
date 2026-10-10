import Observation
import ServiceManagement
import StarboardCore
import SwiftUI

@main
struct StarboardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            StarboardMenu(delegate: delegate)
        } label: {
            MenuBarIcon(status: delegate.status)
        }
    }
}

@MainActor
@Observable
final class Status {
    /// Off means the tap passes every key through.
    var enabled = true
    var launchesAtLogin = SMAppService.mainApp.status == .enabled
}

private struct MenuBarIcon: View {
    let status: Status

    var body: some View {
        Image(systemName: status.enabled ? "command.circle.fill" : "command.circle")
    }
}

private struct StarboardMenu: View {
    let delegate: AppDelegate

    var body: some View {
        Button(delegate.status.enabled ? "Disable Starboard" : "Enable Starboard") {
            delegate.setEnabled(!delegate.status.enabled)
        }
        Divider()
        Button("Open Config File") { NSWorkspace.shared.open(delegate.config.url) }
        if let error = delegate.config.error {
            Text("Config error: \(error.message)")
        }
        Toggle("Launch at Login", isOn: Binding(
            get: { delegate.status.launchesAtLogin },
            set: { delegate.setLaunchAtLogin($0) }
        ))
        Divider()
        Button("Quit Starboard") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let status = Status()
    let config = ConfigStore()
    private let registry = AppRegistry()
    private let windows = WindowService()
    private let toast = ToastHUD()
    private lazy var switcher = AppSwitcher(registry: registry, config: config, windows: windows, toast: toast)
    private var tap: EventTap?
    private var watchdog: Timer?
    private var observers: [NSObjectProtocol] = []
    private var onboardingWindow: NSWindow?

    func applicationDidFinishLaunching(_: Notification) {
        terminateOlderInstances()
        config.onChange = { [weak self] in self?.configChanged() }
        registry.onInstalledChange = { [weak self] in
            guard let self else { return }
            switcher.refreshResolution(announce: true)
            AppIcons.preload(registry.bundleIDs)
        }
        configChanged()

        if AXIsProcessTrusted() {
            startTap()
        } else {
            showOnboarding()
        }

        observers.append(KeyLayout.observeChanges { [weak self] in
            let keyboard = KeyLayout.current()
            self?.tap?.update { $0.keyboard = keyboard }
        })
        // Sleep and screen locks swallow key releases.
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(
                forName: name, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.tap?.invalidate()
                    self?.checkTap()
                }
            })
        }
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkTap() }
        }
    }

    func setEnabled(_ enabled: Bool) {
        status.enabled = enabled
        tap?.setEnabled(enabled)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            toast.show(message: "Launch at login failed: \(error.localizedDescription)")
        }
        status.launchesAtLogin = SMAppService.mainApp.status == .enabled
    }

    private func configChanged() {
        let config = config.config
        tap?.update { $0 = RouterConfig(config, keyboard: $0.keyboard) }
        switcher.refreshResolution(announce: true)
        if let error = self.config.error {
            toast.show(message: "Config error: \(error.message)")
        }
    }

    // MARK: - Tap

    private func startTap() {
        guard tap == nil else { return }
        let tap = EventTap(
            config: RouterConfig(config.config, keyboard: KeyLayout.current()),
            deliver: { [switcher] intents in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { switcher.handle(intents) }
                }
            },
            onFailure: { [weak self] in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.tapFailed() }
                }
            }
        )
        do {
            try tap.start()
        } catch {
            log.error("Could not create the event tap: \(error)")
            return
        }
        tap.setEnabled(status.enabled)
        self.tap = tap
    }

    /// Runs every few seconds and after waking. Revoking Accessibility tears
    /// the tap down without telling anyone, so that is checked first.
    private func checkTap() {
        // Onboarding starts the tap once it sees the grant.
        guard status.enabled, onboardingWindow == nil else { return }
        guard AXIsProcessTrusted() else {
            tap?.stop()
            tap = nil
            showOnboarding()
            return
        }
        guard let tap, tap.isValid else {
            self.tap?.stop()
            self.tap = nil
            startTap()
            return
        }
        if !tap.isEnabled {
            log.info("The event tap was off; turning it back on")
            tap.setEnabled(true)
        }
    }

    private func tapFailed() {
        status.enabled = false
        toast.show(message: "Starboard turned off: the key tap kept stalling")
    }

    /// Two Starboards would fight over every Right Command key, so the newest
    /// launch asks older ones to quit. Process IDs wrap, so launch dates
    /// decide.
    private func terminateOlderInstances() {
        guard let bundleID = Bundle.main.bundleIdentifier,
              let ownLaunch = NSRunningApplication.current.launchDate else { return }
        let ownPID = ProcessInfo.processInfo.processIdentifier
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            where app.processIdentifier != ownPID && (app.launchDate ?? .distantPast) < ownLaunch
        {
            log.info("Taking over from instance \(app.processIdentifier)")
            app.terminate()
        }
    }

    // MARK: - Onboarding

    private func showOnboarding() {
        onboardingWindow = showWindow(
            OnboardingView { [weak self] in self?.accessibilityGranted() },
            size: NSSize(width: 460, height: 300)
        )
    }

    private func accessibilityGranted() {
        onboardingWindow?.close()
        onboardingWindow = nil
        startTap()
    }
}
