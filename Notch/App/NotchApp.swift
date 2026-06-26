import SwiftUI

@main
struct NotchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // The notch itself lives in an AppKit panel (see AppDelegate). This scene
        // is only the standard Settings window.
        SwiftUI.Settings {
            SettingsView()
                .injectNotchEnvironment(appDelegate.env)
                .frame(width: 460, height: 520)
        }
    }
}
