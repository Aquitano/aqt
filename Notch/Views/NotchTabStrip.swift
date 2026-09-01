import SwiftUI
import AppKit

/// The expanded panel's tab switcher plus the gear, rendered either inside the
/// blob (glass strip on black) or as the detached floating capsule below it —
/// same buttons, same selection pill, one source for both placements.
struct NotchTabStrip: View {
    /// Detached capsule below the blob: draws its own glass and a soft shadow
    /// because it sits over the desktop, not over the black pill.
    var floating = false

    @Environment(NotchState.self) private var state
    @Environment(Settings.self) private var settings

    @Environment(\.openSettings) private var openSettings

    @Namespace private var tabNamespace

    var body: some View {
        HStack(spacing: 4) {
            ForEach(visibleTabs) { tab in
                tabButton(tab)
            }
            gearButton
        }
        .padding(4)
        .glassEffect(.regular, in: .capsule)
        .shadow(color: .black.opacity(floating ? 0.35 : 0), radius: 12, y: 4)
    }

    private var visibleTabs: [NotchState.ExpandedTab] {
        settings.tabLayout.filter { $0 != .agents || settings.agentsEnabled }
    }

    private func tabButton(_ tab: NotchState.ExpandedTab) -> some View {
        let selected = state.expandedTab == tab
        return Button {
            Haptics.tap(.levelChange)
            state.select(tab: tab)
        } label: {
            PixelIcon(systemName: tab.symbol, size: 16,
                      tint: selected ? Color.white : Color.white.opacity(0.5))
                .frame(width: 46, height: 32)
                .background {
                    // One shared pill that slides between tabs as the selection
                    // moves. A capsule so its curvature matches the capsule strip
                    // around it instead of reading as a rounded-rect inside a pill.
                    if selected {
                        Capsule(style: .continuous)
                            .fill(.white.opacity(0.18))
                            .matchedGeometryEffect(id: "tabSelection", in: tabNamespace)
                    }
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.rawValue.capitalized)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Opens the standard Settings window (all settings live there).
    private var gearButton: some View {
        Button {
            Haptics.tap(.levelChange)
            // Settings replaces the notch as the active surface. Collapse before
            // activating its window instead of waiting for a hover-exit event.
            state.collapseImmediately()
            // An accessory app isn't frontmost when the notch panel is clicked, so
            // openSettings() alone leaves the window buried or unshown. Activate
            // first to reliably surface it (mirrors the status-item menu path).
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        } label: {
            PixelIcon(systemName: "gearshape", size: 16,
                      tint: Color.white.opacity(0.5))
                .frame(width: 46, height: 32)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Settings")
    }
}
