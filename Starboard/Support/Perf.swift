import Foundation
import os

/// Signposts consumed by Instruments' Points of Interest template. Keeping the
/// names static makes hot-path instrumentation allocation-free when recording.
enum Perf {
    private static let signposter = OSSignposter(
        subsystem: Bundle.main.bundleIdentifier ?? "com.thomasbreindl.starboard",
        category: "Performance"
    )

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
}
