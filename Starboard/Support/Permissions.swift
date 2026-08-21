import ApplicationServices

enum Permissions {
    /// Whether we can create an event tap; shows the system prompt on first ask.
    static func requestAccessibility() -> Bool {
        let options = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
        ] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    static var hasAccessibility: Bool {
        AXIsProcessTrusted()
    }

    // TODO(Phase 4): Screen Recording preflight/request for window titles
    // (CGPreflightScreenCaptureAccess / CGRequestScreenCaptureAccess).
}
