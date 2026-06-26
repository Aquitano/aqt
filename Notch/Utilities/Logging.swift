import OSLog

/// Lightweight typed loggers. Use `Log.media.debug(...)` etc.
enum Log {
    private static let subsystem = "com.aquitano.notch"
    static let app = Logger(subsystem: subsystem, category: "app")
    static let window = Logger(subsystem: subsystem, category: "window")
    static let media = Logger(subsystem: subsystem, category: "media")
    static let hud = Logger(subsystem: subsystem, category: "hud")
    static let activity = Logger(subsystem: subsystem, category: "activity")
    static let tray = Logger(subsystem: subsystem, category: "tray")
    static let widgets = Logger(subsystem: subsystem, category: "widgets")
}
