import CoreGraphics
import Foundation

/// Where the notch should live. `.all` is part of the policy model now so the
/// multi-panel milestone can build on the same tested selection rules; the UI
/// exposes it only once the window coordinator can host every target.
package enum DisplayPlacement: String, Codable, CaseIterable, Identifiable, Sendable {
    case builtIn
    case main
    case all

    package var id: String { rawValue }

    package var title: String {
        switch self {
        case .builtIn: return "Built-in Display"
        case .main: return "Main Display"
        case .all: return "All Displays"
        }
    }
}

/// Chooses whether a display uses detached pill chrome or the traditional
/// top-edge notch shape. Geometry remains physical-notch-safe in every mode.
package enum VirtualNotchMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case automatic
    case always
    case never

    package var id: String { rawValue }

    package var title: String {
        switch self {
        case .automatic: return "Automatic"
        case .always: return "Always"
        case .never: return "Never"
        }
    }

    package func usesVirtualChrome(for display: DisplayDescriptor) -> Bool {
        switch self {
        case .automatic: return !display.hasPhysicalNotch
        case .always: return true
        case .never: return false
        }
    }
}

/// Per-display layout tuning. Adjustments are relative to the measured physical
/// notch or the standard virtual pill and are clamped before use.
package struct DisplayProfile: Codable, Equatable, Sendable, Identifiable {
    package var displayKey: String
    package var compactWidthAdjustment: Double = 0
    package var compactHeightAdjustment: Double = 0
    package var horizontalOffset: Double = 0
    package var verticalOffset: Double = 0
    package var expandedWidthAdjustment: Double = 0
    /// Per-display overrides; nil follows the global setting. Stored as raw
    /// values so this file stays free of the WidgetKind / NotchState types
    /// (Settings owns the typed resolution).
    package var widgetLayout: [String]?
    package var defaultTab: String?

    package var id: String { displayKey }

    package static func standard(for displayKey: String) -> DisplayProfile {
        DisplayProfile(displayKey: displayKey)
    }

    package var normalized: DisplayProfile {
        var copy = self
        copy.compactWidthAdjustment = compactWidthAdjustment.clamped(to: -40...160)
        copy.compactHeightAdjustment = compactHeightAdjustment.clamped(to: -6...20)
        copy.horizontalOffset = horizontalOffset.clamped(to: -240...240)
        copy.verticalOffset = verticalOffset.clamped(to: 0...80)
        copy.expandedWidthAdjustment = expandedWidthAdjustment.clamped(to: -80...180)
        return copy
    }
}

extension Double {
    package func clamped(to range: ClosedRange<Double>) -> Double {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

/// AppKit-free snapshot of one online display. Keeping selection inputs as
/// values makes dock/undock behavior deterministic and hostless-testable.
package struct DisplayDescriptor: Equatable, Sendable {
    package let key: String
    package let displayID: UInt32
    package let name: String
    package let frame: CGRect
    package let safeAreaTop: CGFloat
    package let auxiliaryLeftWidth: CGFloat?
    package let auxiliaryRightWidth: CGFloat?
    package let isBuiltIn: Bool
    package let isMain: Bool

    package init(key: String, displayID: UInt32, name: String, frame: CGRect, safeAreaTop: CGFloat,
                 auxiliaryLeftWidth: CGFloat?, auxiliaryRightWidth: CGFloat?, isBuiltIn: Bool, isMain: Bool) {
        self.key = key
        self.displayID = displayID
        self.name = name
        self.frame = frame
        self.safeAreaTop = safeAreaTop
        self.auxiliaryLeftWidth = auxiliaryLeftWidth
        self.auxiliaryRightWidth = auxiliaryRightWidth
        self.isBuiltIn = isBuiltIn
        self.isMain = isMain
    }

    package var hasPhysicalNotch: Bool { safeAreaTop > 0 }

    /// Public CoreGraphics exposes vendor/model/serial but not a persistent
    /// display UUID. Serial is stable across reconnects when the monitor reports
    /// one; otherwise the hardware unit number is a better fallback than the
    /// transient direct-display id and distinguishes identical online panels.
    package static func stableKey(
        unitNumber: UInt32,
        vendor: UInt32,
        model: UInt32,
        serial: UInt32,
        name: String,
        isBuiltIn: Bool
    ) -> String {
        if isBuiltIn {
            return "builtin-\(vendor)-\(model)-\(serial)"
        }
        if serial != 0 {
            return "display-\(vendor)-\(model)-\(serial)"
        }
        let normalizedName = name
            .lowercased()
            .unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? String($0) : "-" }
            .joined()
        let slug = normalizedName.split(separator: "-").joined(separator: "-")
        return "display-\(vendor)-\(model)-\(slug)-unit\(unitNumber)"
    }
}

package struct DisplaySelection: Equatable, Sendable {
    package enum Reason: Equatable, Sendable {
        case requested
        case activeDisplay
        case activeDisplayUnavailable
        case builtInUnavailable
        case mainUnavailable
        case noDisplays
    }

    package let targets: [DisplayDescriptor]
    package let reason: Reason
}

/// Pure display-target resolution. Never relies on `NSScreen.screens` ordering.
package enum DisplaySelectionPolicy {
    package static func resolve(
        displays: [DisplayDescriptor],
        placement: DisplayPlacement,
        followActiveDisplay: Bool = false,
        activeDisplayKey: String? = nil
    ) -> DisplaySelection {
        guard !displays.isEmpty else {
            return DisplaySelection(targets: [], reason: .noDisplays)
        }

        let ordered = displays.sorted(by: displayOrder)
        if followActiveDisplay, placement != .all {
            if let activeDisplayKey,
               let active = ordered.first(where: { $0.key == activeDisplayKey }) {
                return DisplaySelection(targets: [active], reason: .activeDisplay)
            }
            let fallback = resolve(displays: displays, placement: placement)
            return DisplaySelection(targets: fallback.targets, reason: .activeDisplayUnavailable)
        }
        switch placement {
        case .builtIn:
            if let builtIn = ordered.first(where: \.isBuiltIn) {
                return DisplaySelection(targets: [builtIn], reason: .requested)
            }
            if let main = ordered.first(where: \.isMain) {
                return DisplaySelection(targets: [main], reason: .builtInUnavailable)
            }
            return DisplaySelection(targets: [ordered[0]], reason: .builtInUnavailable)

        case .main:
            if let main = ordered.first(where: \.isMain) {
                return DisplaySelection(targets: [main], reason: .requested)
            }
            if let builtIn = ordered.first(where: \.isBuiltIn) {
                return DisplaySelection(targets: [builtIn], reason: .mainUnavailable)
            }
            return DisplaySelection(targets: [ordered[0]], reason: .mainUnavailable)

        case .all:
            return DisplaySelection(targets: ordered, reason: .requested)
        }
    }

    private static func displayOrder(_ lhs: DisplayDescriptor, _ rhs: DisplayDescriptor) -> Bool {
        if lhs.isMain != rhs.isMain { return lhs.isMain }
        if lhs.isBuiltIn != rhs.isBuiltIn { return lhs.isBuiltIn }
        if lhs.frame.minX != rhs.frame.minX { return lhs.frame.minX < rhs.frame.minX }
        if lhs.frame.minY != rhs.frame.minY { return lhs.frame.minY > rhs.frame.minY }
        return lhs.key < rhs.key
    }
}

/// Pure key selection shared by the multi-panel coordinator. Interaction keeps
/// its current owner while valid; passive shared work follows the active screen.
package enum DisplayHostPolicy {
    package static func interactionKey(
        availableKeys: Set<String>,
        current: String?,
        active: String?
    ) -> String? {
        if let current, availableKeys.contains(current) { return current }
        if let active, availableKeys.contains(active) { return active }
        return availableKeys.sorted().first
    }

    package static func primaryKey(
        availableKeys: Set<String>,
        active: String?,
        interaction: String?
    ) -> String? {
        if let active, availableKeys.contains(active) { return active }
        if let interaction, availableKeys.contains(interaction) { return interaction }
        return availableKeys.sorted().first
    }
}

package enum DisplayHostMigrationInstruction: Equatable, Sendable {
    case keepPresentation
    case collapse
    case endTransientInteractionAndCollapse
    case restoreProgrammaticExpansion
}

/// Describes how presentation should survive removal of its owning display.
/// The coordinator performs the AppKit cleanup; this value policy stays
/// hostless so disconnect and placement-change behavior is deterministic.
package enum DisplayHostMigrationPolicy {
    package static func instruction(
        targetStillAvailable: Bool,
        wasExpanded: Bool,
        wasHovering: Bool,
        hasTransientInteraction: Bool
    ) -> DisplayHostMigrationInstruction {
        if targetStillAvailable { return .keepPresentation }
        if hasTransientInteraction { return .endTransientInteractionAndCollapse }
        guard wasExpanded else { return .keepPresentation }
        return wasHovering ? .collapse : .restoreProgrammaticExpansion
    }
}
