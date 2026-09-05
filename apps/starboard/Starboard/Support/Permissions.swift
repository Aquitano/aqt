import ApplicationServices

enum Permissions {
    /// Whether we can create an event tap; shows the system prompt on first ask.
    static func requestAccessibility() -> Bool {
        let options = [
            "AXTrustedCheckOptionPrompt": true
        ] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    static var hasAccessibility: Bool {
        AXIsProcessTrusted()
    }

    /// Screen Recording gates reading other apps' window titles; everything
    /// else works without it (windows show as "App Window") (BATTLEPLAN §3.5).
    static var hasScreenRecording: Bool {
        CGPreflightScreenCaptureAccess()
    }

    @discardableResult
    static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }
}
