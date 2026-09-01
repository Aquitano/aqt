import SwiftUI
import NotchCore
import AppKit

/// The expanded panel's section switcher, dissolved into the frame. Instead of a
/// glass strip that costs the body a row, the icons sit straight on the two black
/// shoulders flanking the physical cutout — the band the blob already spends on
/// the notch — so they read as status items living in the frame rather than as
/// chrome stacked on top of the content.
struct NotchShoulderTabs: View {
    @Environment(NotchState.self) private var state
    @Environment(Settings.self) private var settings

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.notchExpandedWidth) private var expandedWidth
    @Environment(\.openSettings) private var openSettings

    @Namespace private var selectionNamespace
    @State private var hovered: Item?

    /// Everything the row can hover, so the brightening is driven by one piece of
    /// state instead of a flag per button.
    private enum Item: Hashable {
        case tab(NotchState.ExpandedTab)
        case settings
    }

    private static let iconSize: CGFloat = 16
    private static let tabWidth: CGFloat = 40
    private static let underlineSize = CGSize(width: 14, height: 2.5)
    private static let underlineGap: CGFloat = 3

    var body: some View {
        let (leading, trailing) = shoulders
        return HStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(leading, content: tabButton)
            }
            Spacer(minLength: 0)
            // The cutout itself: nothing may draw across it, and it must not take
            // the clicks the blob underneath is entitled to.
            Color.clear.frame(width: notchSize.width).allowsHitTesting(false)
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                ForEach(trailing, content: tabButton)
                settingsButton
            }
        }
        .frame(height: notchSize.height)
        // Only the shoulder curve is subtracted here: each button carries 12pt of
        // slack around its 16pt glyph, which is what lands the icons on the same
        // visible margin the body below them uses.
        .padding(.horizontal, NotchMetrics.shoulderInset(
            width: expandedWidth, notchWidth: notchSize.width))
        .animation(.easeOut(duration: 0.15), value: hovered)
    }

    /// The visible tabs dealt onto the two shoulders in their configured order:
    /// the first half left of the cutout, the rest right of it. The gear takes a
    /// trailing slot, so it counts when picking where to cut — otherwise the right
    /// shoulder always carries one icon more than the left.
    private var shoulders: (leading: [NotchState.ExpandedTab], trailing: [NotchState.ExpandedTab]) {
        let tabs = settings.notch.tabLayout.filter { $0 != .agents || settings.agents.enabled }
        let cut = (tabs.count + 2) / 2
        return (Array(tabs.prefix(cut)), Array(tabs.dropFirst(cut)))
    }

    private func tabButton(_ tab: NotchState.ExpandedTab) -> some View {
        let selected = state.expandedTab == tab
        return button(symbol: tab.symbol, item: .tab(tab), selected: selected,
                      label: tab.title) {
            Haptics.tap(.levelChange)
            state.select(tab: tab)
        }
    }

    /// Opens the standard Settings window (all settings live there).
    private var settingsButton: some View {
        button(symbol: "gearshape", item: .settings, selected: false, label: "Settings") {
            Haptics.tap(.levelChange)
            // Settings replaces the notch as the active surface. Collapse before
            // activating its window instead of waiting for a hover-exit event.
            state.collapseImmediately()
            // An accessory app isn't frontmost when the notch panel is clicked, so
            // openSettings() alone leaves the window buried or unshown. Activate
            // first to reliably surface it (mirrors the status-item menu path).
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        }
    }

    private func button(symbol: String, item: Item, selected: Bool,
                        label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: Self.underlineGap) {
                PixelIcon(systemName: symbol, size: Self.iconSize, tint: .white)
                    .opacity(brightness(of: item, selected: selected))
                underline(selected: selected)
            }
            .frame(width: Self.tabWidth, height: notchSize.height)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside {
                hovered = item
            } else if hovered == item {
                hovered = nil
            }
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The selection cue: a hairline under the active icon that glides across the
    /// cutout to its new shoulder. Unselected buttons keep a clear stand-in of the
    /// same size so switching tabs never shifts the icons up or down.
    @ViewBuilder
    private func underline(selected: Bool) -> some View {
        if selected {
            Capsule(style: .continuous)
                .fill(.white)
                .frame(width: Self.underlineSize.width, height: Self.underlineSize.height)
                .matchedGeometryEffect(id: "shoulderSelection", in: selectionNamespace)
        } else {
            Color.clear
                .frame(width: Self.underlineSize.width, height: Self.underlineSize.height)
        }
    }

    private func brightness(of item: Item, selected: Bool) -> Double {
        if selected { return 1 }
        return hovered == item ? 0.72 : 0.4
    }
}
