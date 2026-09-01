import SwiftUI
import NotchCore

/// Real entry point. Branches on argv *before* AppKit loads so the same binary
/// can serve as a Claude hook / Codex notify client (write one line to the agent
/// socket, exit) without ever spinning up the UI.
@main
enum NotchMain {
    static func main() {
        switch CommandLine.arguments.dropFirst().first {
        case "--agent-hook": HookClient.dispatch(Array(CommandLine.arguments.dropFirst()))
        default:             NotchApp.main()
        }
    }
}

struct NotchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // The notch itself lives in an AppKit panel (see AppDelegate). This scene
        // is only the standard Settings window.
        SwiftUI.Settings {
            SettingsView(settings: appDelegate.env.settings)
                .injectNotchEnvironment(appDelegate.env)
        }
    }
}
