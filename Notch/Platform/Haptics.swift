import AppKit

/// Small wrapper over the trackpad haptic engine. `Settings` mirrors the user's
/// "Haptic feedback" preference into `isEnabled`, so call sites stay one line.
@MainActor
enum Haptics {

    static var isEnabled = true

    static func tap(_ pattern: NSHapticFeedbackManager.FeedbackPattern = .generic) {
        guard isEnabled else { return }
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
    }
}
