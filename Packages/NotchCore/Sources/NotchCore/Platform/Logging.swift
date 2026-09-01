import OSLog

/// Lightweight typed loggers. Use `Log.media.debug(...)` etc.
package enum Log {
    private static let subsystem = "com.aquitano.notch"
    package static let app = Logger(subsystem: subsystem, category: "app")
    package static let window = Logger(subsystem: subsystem, category: "window")
    package static let media = Logger(subsystem: subsystem, category: "media")
    package static let hud = Logger(subsystem: subsystem, category: "hud")
    package static let activity = Logger(subsystem: subsystem, category: "activity")
    package static let tray = Logger(subsystem: subsystem, category: "tray")
    package static let widgets = Logger(subsystem: subsystem, category: "widgets")
    package static let agents = Logger(subsystem: subsystem, category: "agents")
}
