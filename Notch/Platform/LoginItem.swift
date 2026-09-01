import ServiceManagement
import NotchCore

/// Thin wrapper over `SMAppService.mainApp` so the launch-at-login preference and
/// the OS registration stay in sync. Reads reflect the real registration state,
/// not just the stored bool, so a user toggling the login item in System Settings
/// is honoured on next launch.
enum LoginItem {

    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // Registration fails for an unsigned dev build run outside /Applications;
            // the stored preference still records intent for the next proper launch.
            Log.app.error("Login item update failed: \(error.localizedDescription)")
        }
    }
}
