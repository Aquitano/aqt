import SwiftUI

// MARK: - Notch geometry through the environment

private struct NotchGeometryKey: EnvironmentKey {
    static let defaultValue: CGSize = NotchMetrics.fallbackNotchSize
}

private struct NotchExpandedWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = NotchMetrics.expandedWidth
}

extension EnvironmentValues {
    /// The physical notch size, injected by the window controller.
    var notchGeometry: CGSize {
        get { self[NotchGeometryKey.self] }
        set { self[NotchGeometryKey.self] = newValue }
    }

    /// Per-display expanded width, injected from the same geometry snapshot as
    /// the physical/virtual notch size.
    var notchExpandedWidth: CGFloat {
        get { self[NotchExpandedWidthKey.self] }
        set { self[NotchExpandedWidthKey.self] = newValue }
    }
}

// MARK: - Color helpers

extension Color {
    /// Parse "#RRGGBB" / "RRGGBB" (EventKit calendar colors come through as hex).
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}

// MARK: - Time formatting

extension TimeInterval {
    /// "3:07" (or "1:03:07" past an hour) clock string; "0:00" for non-finite or
    /// negative values. Without the hour component a 90-minute value read "90:00".
    var clockString: String {
        guard isFinite, self >= 0 else { return "0:00" }
        let total = Int(self.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }
}
