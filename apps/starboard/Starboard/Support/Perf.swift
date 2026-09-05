import Foundation
import os

/// Signposts consumed by Instruments' Points of Interest template. Keeping the
/// names static makes hot-path instrumentation allocation-free when recording.
enum Perf {
    private static let subsystem = Bundle.main.bundleIdentifier ?? "com.aquitano.starboard"
    private static let signposter = OSSignposter(subsystem: subsystem, category: "Performance")
    private static let logger = Logger(subsystem: subsystem, category: "Performance")

    /// Instruments is recording. The event tap checks this before paying for
    /// an interval on every keystroke system-wide.
    static var signpostsEnabled: Bool {
        signposter.isEnabled
    }

    static func beginEventRouting() -> OSSignpostIntervalState {
        signposter.beginInterval("Event routing")
    }

    static func endEventRouting(_ state: OSSignpostIntervalState) {
        signposter.endInterval("Event routing", state)
    }

    static func beginWindowEnumeration() -> OSSignpostIntervalState {
        signposter.beginInterval("Window enumeration")
    }

    static func endWindowEnumeration(_ state: OSSignpostIntervalState) {
        signposter.endInterval("Window enumeration", state)
    }

    static func beginSearchRanking() -> OSSignpostIntervalState {
        signposter.beginInterval("Search ranking")
    }

    static func endSearchRanking(_ state: OSSignpostIntervalState) {
        signposter.endInterval("Search ranking", state)
    }

    static func beginInstalledAppScan() -> OSSignpostIntervalState {
        signposter.beginInterval("Installed app scan")
    }

    static func endInstalledAppScan(_ state: OSSignpostIntervalState) {
        signposter.endInterval("Installed app scan", state)
    }

    /// The first activation attempt was refused. The rate of this event is the
    /// activation failure rate.
    static func activationRetried(_ appName: String) {
        signposter.emitEvent("Activation retry")
        logger.log("Activation retry: \(appName, privacy: .public)")
    }
}
