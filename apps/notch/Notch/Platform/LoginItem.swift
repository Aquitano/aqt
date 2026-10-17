import ServiceManagement

/// `SMAppService.mainApp` is the only record of launch at login: the user can
/// change it in System Settings. Registration errors go to Diagnostics.
enum LoginItem {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func setEnabled(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}
