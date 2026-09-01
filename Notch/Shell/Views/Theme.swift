import SwiftUI

/// Shared visual tokens. Reach for these instead of scattering magic numbers so
/// every surface uses the same spacing rhythm and corner radii.
enum Theme {
    enum Spacing {
        static let tiny: CGFloat = 4
        static let small: CGFloat = 8
        static let medium: CGFloat = 12
        static let large: CGFloat = 16
    }
    enum Radius {
        static let card: CGFloat = 16
        static let control: CGFloat = 10
    }
}

extension View {
    /// The standard glass tile used across the expanded surface: uniform padding,
    /// fills its grid cell, and carries one regular-glass background. Keeping this
    /// in one place is what makes the widget grid read as a single system.
    func notchCard(padding: CGFloat = Theme.Spacing.medium,
                   cornerRadius: CGFloat = Theme.Radius.card) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
    }
}
