import SwiftUI

@main
struct StarboardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Starboard", systemImage: "command.circle.fill") {
            SettingsLink { Text("Settings…") }
            Divider()
            Button("Quit Starboard") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }

        Settings {
            SettingsView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let modifiers = ModifierTracker()
    private let router = KeyRouter()
    private let switcher = AppSwitcher(registry: AppRegistry())
    private var eventTap: EventTap?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard Permissions.requestAccessibility() else {
            // TODO(Phase 1): onboarding window with live permission re-check that
            // starts the tap once granted, instead of requiring a relaunch.
            return
        }
        startTap()
    }

    private func startTap() {
        let tap = EventTap { [modifiers, router, switcher] type, event in
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            switch type {
            case .flagsChanged:
                return modifiers.handleFlagsChanged(keyCode: keyCode, flags: event.flags)
            case .keyDown:
                guard let intent = router.route(keyDownCode: keyCode, modifiers: modifiers.state) else {
                    return false
                }
                DispatchQueue.main.async { switcher.handle(intent) }
                return true
            case .keyUp:
                // Swallow the matching keyUp while rcmd is held so apps never see
                // half a keystroke.
                return modifiers.state.rightCommandHeld && Keycode.letters[keyCode] != nil
            default:
                return false
            }
        }

        do {
            try tap.start()
            eventTap = tap
        } catch {
            NSLog("Starboard: failed to create event tap: \(error)")
        }
    }
}
