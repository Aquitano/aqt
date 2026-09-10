import OSLog

package enum Log {
    private static let subsystem = "com.aquitano.tracker-agent"
    package static let agent = Logger(subsystem: subsystem, category: "agent")
    package static let focus = Logger(subsystem: subsystem, category: "focus")
    package static let idle = Logger(subsystem: subsystem, category: "idle")
    package static let outbox = Logger(subsystem: subsystem, category: "outbox")
}
