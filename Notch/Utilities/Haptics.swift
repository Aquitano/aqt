import AppKit

/// Small wrapper over the trackpad haptic engine. Gated by the user's preference
/// so the "Haptic feedback" setting actually changes behaviour.
@MainActor
enum Haptics {

    static func tap(_ pattern: NSHapticFeedbackManager.FeedbackPattern = .generic) {
        guard Settings.shared.hapticFeedback else { return }
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
    }
}
