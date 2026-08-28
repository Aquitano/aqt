import CoreGraphics
import Observation
import SwiftUI

/// Shared UI-facing state. AppDelegate writes it; menu bar and onboarding read it.
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var accessibilityGranted = Permissions.hasAccessibility
    /// Kill switch: false means the tap is disabled and keys pass through.
    @Published var starboardEnabled = true
    /// Active Space number for the menu bar (direct strategy + setting only).
    @Published var spaceNumber: Int?
}

@main
struct StarboardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @ObservedObject private var state = AppState.shared

    var body: some Scene {
        MenuBarExtra {
            Button(state.starboardEnabled ? "Disable Starboard" : "Enable Starboard") {
                appDelegate.setEnabled(!state.starboardEnabled)
            }
            SettingsLink { Text("Settings…") }
            Divider()
            Button("About Starboard") { appDelegate.showAbout() }
            Divider()
            Button("Quit Starboard") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        } label: {
            if let number = state.spaceNumber {
                Image(systemName: "\(number).circle\(state.starboardEnabled ? ".fill" : "")")
            } else {
                Image(systemName: state.starboardEnabled
                    ? "command.circle.fill" : "command.circle")
            }
        }

        Settings {
            SettingsView()
        }
    }
}

/// The settings the event tap reads on every keystroke. Reading `settings.model`
/// there copies the whole struct (retaining its arrays) inside the hot path;
/// this snapshot is refreshed only when the settings actually change.
private final class TapSettings {
    var stagesTrigger = StagesTrigger.capsLock
    var windowJumpEnabled = false
    var spacesMoveWindowEnabled = false
    /// Letters that currently name a Stage.
    var stageLetters: Set<Character> = []
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let state = AppState.shared
    private let settings = SettingsStore.shared
    private lazy var registry = AppRegistry()
    private lazy var switcher = AppSwitcher(registry: registry, settings: settings)
    private let tapSettings = TapSettings()
    private let modifiers = ModifierTracker()
    private lazy var router = KeyRouter(hasStage: { [tapSettings] letter in
        tapSettings.stageLetters.contains(letter)
    })
    private var eventTap: EventTap?
    private var watchdog: Timer?
    private var onboardingWindow: NSWindow?
    private var aboutWindow: NSWindow?
    private var tapFailureObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        tapFailureObserver = NotificationCenter.default.addObserver(
            forName: EventTap.failedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.tapRecoveryFailed() }
        }

        trackTapSettings()

        if Permissions.hasAccessibility {
            startTapIfWanted()
        } else {
            showOnboarding()
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                WindowEnumerator.invalidateCache()
                self?.refreshSpaceNumber()
            }
        }
        refreshSpaceNumber()

        // Watchdog: the tap can be silently disabled by the OS (timeout / user
        // input) — re-enable it (BATTLEPLAN §7).
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.state.starboardEnabled,
                      let tap = self.eventTap, !tap.isEnabled else { return }
                NSLog("Starboard: tap was disabled by the system, re-enabling")
                tap.recoverIfNeeded()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Persistence is coalesced to the next run-loop turn; a quit in the
        // same turn as a change must not lose it.
        settings.flush()
    }

    func setEnabled(_ enabled: Bool) {
        state.starboardEnabled = enabled
        syncTap()
    }

    private func refreshSpaceNumber() {
        state.spaceNumber = settings.model.showSpaceNumber
            ? switcher.spaces.currentSpaceNumber : nil
    }

    private func syncTap() {
        guard let tap = eventTap else { return }
        state.starboardEnabled ? tap.enable() : tap.disable()
    }

    private func tapRecoveryFailed() {
        state.starboardEnabled = false
        ToastHUD.shared.show(message: "Starboard disabled — tap kept failing")
    }

    // MARK: - Tap lifecycle

    private func startTapIfWanted() {
        state.accessibilityGranted = true
        do {
            let tap = try makeTap()
            eventTap = tap
            if state.starboardEnabled { tap.enable() }
        } catch {
            NSLog("Starboard: failed to create event tap: \(error)")
        }
    }

    private func makeTap() throws -> EventTap {
        // The tap source lives on the main run loop, so the callback runs on
        // the main thread — touching these captures here is safe.
        let tap = EventTap { [modifiers, router, tapSettings, switcher] type, event in
            // Events Starboard posted itself (Space shortcuts) must pass
            // through untouched or they'd be re-routed while rcmd is held.
            if event.getIntegerValueField(.eventSourceUserData) == SyntheticSpaceSwitcher.syntheticTag {
                return false
            }
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            switch type {
            case .flagsChanged:
                // Stages leader: Caps Lock is consumed (so the lock never
                // toggles) and arms the 3-second command window.
                if keyCode == Keycode.capsLock {
                    guard tapSettings.stagesTrigger == .capsLock else { return false }
                    Self.dispatch(router.armStages(), to: switcher)
                    return true
                }
                let (was, now) = Self.syncModifiers(modifiers, event, router: router, switcher: switcher)
                if tapSettings.stagesTrigger == .rightShift {
                    if !was.rightShiftHeld && now.rightShiftHeld {
                        router.rightShiftDown()
                    } else if was.rightShiftHeld && !now.rightShiftHeld {
                        Self.dispatch(router.rightShiftUp(), to: switcher)
                    }
                }
                return false
            case .keyDown:
                Self.syncModifiers(modifiers, event, router: router, switcher: switcher)
                // Auto-repeat never reaches the session: a held letter would
                // re-fire the switch (cycling or hiding the app) and duplicate
                // characters in the search query.
                if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 {
                    return router.isConsumed(keyCode)
                }
                let (intents, consume) = router.keyDown(
                    keyCode,
                    modifiers: modifiers.state,
                    options: RouterOptions(
                        windowJumpEnabled: tapSettings.windowJumpEnabled,
                        spacesMoveWindowEnabled: tapSettings.spacesMoveWindowEnabled
                            && switcher.spaces.canMoveWindows
                    )
                )
                Self.dispatch(intents, to: switcher)
                return consume
            case .keyUp:
                Self.syncModifiers(modifiers, event, router: router, switcher: switcher)
                return router.shouldConsumeKeyUp(keyCode)
            default:
                return false
            }
        }
        tap.onStateInvalidated = { [modifiers, router] in
            modifiers.reset()
            router.reset()
        }
        try tap.start()
        return tap
    }

    /// Reconciles the tracked modifiers with the event's flags and drives the
    /// hold lifecycle across the transition. Every event carries the full
    /// modifier picture, so an rcmd release the tap never saw (secure input,
    /// screen lock, an OS disable) heals on the next keystroke instead of
    /// swallowing every letter.
    @discardableResult
    private static func syncModifiers(
        _ modifiers: ModifierTracker,
        _ event: CGEvent,
        router: KeyRouter,
        switcher: AppSwitcher
    ) -> (was: ModifierState, now: ModifierState) {
        let was = modifiers.state
        let now = modifiers.update(flags: event.flags)
        if !was.rightCommandHeld && now.rightCommandHeld {
            dispatch(router.rightCommandDown(), to: switcher)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { switcher.holdBegan() }
            }
        } else if was.rightCommandHeld && !now.rightCommandHeld {
            dispatch(router.rightCommandUp(), to: switcher)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { switcher.endHold() }
            }
        }
        return (was, now)
    }

    /// Keeps the tap's settings snapshot fresh. `withObservationTracking` fires
    /// once per change and must be re-armed, and it fires *before* the value is
    /// written — hence the hop.
    private func trackTapSettings() {
        withObservationTracking {
            let model = settings.model
            tapSettings.stagesTrigger = model.stagesTrigger
            tapSettings.windowJumpEnabled = model.windowJumpEnabled
            tapSettings.spacesMoveWindowEnabled = model.spacesMoveWindowEnabled
            tapSettings.stageLetters = Set(model.stages.compactMap { $0.letter.first })
        } onChange: { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.trackTapSettings() }
            }
        }
    }

    private static func dispatch(_ intents: [Intent], to switcher: AppSwitcher) {
        guard !intents.isEmpty else { return }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                intents.forEach { switcher.handle($0) }
            }
        }
    }

    // MARK: - Onboarding

    private func showOnboarding() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 300),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.contentView = NSHostingView(
            rootView: OnboardingView(onGranted: { [weak self] in
                self?.accessibilityGranted()
            })
        )
        window.center()
        onboardingWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func accessibilityGranted() {
        onboardingWindow?.close()
        onboardingWindow = nil
        startTapIfWanted()
    }

    // MARK: - About

    func showAbout() {
        if let aboutWindow {
            NSApp.activate(ignoringOtherApps: true)
            aboutWindow.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 280),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "About Starboard"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AboutView())
        window.center()
        aboutWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
}
