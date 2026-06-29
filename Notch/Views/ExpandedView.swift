import SwiftUI
import AppKit

/// The full expanded panel body. Lives inside the black notch blob, so every
/// chrome surface here is glass-on-black (never glass on the pill itself). A
/// single `GlassEffectContainer` lets the tab strip and the cards below it
/// blend as one liquid-glass system.
struct ExpandedView: View {
    let namespace: Namespace.ID

    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var settings: Settings

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.openSettings) private var openSettings

    @Namespace private var tabNamespace

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            VStack(spacing: 12) {
                if !state.isDropActive { tabStrip }
                content
            }
            // The blob insets its own left/right edges by the notch corner radius,
            // so the horizontal padding must add that back to read as the same
            // visible margin as the bottom; otherwise the sides look pinched and
            // the bottom looks loose.
            .padding(.horizontal, 12 + NotchMetrics.compactCornerRadius)
            .padding(.bottom, 12)
            // Keep the tap targets well clear of the physical notch / menu-bar band,
            // which otherwise crowds the top tab row and eats clicks near the notch.
            .padding(.top, notchSize.height + 14)
        }
        .foregroundStyle(.white)
        .tint(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Tab strip

    private var tabStrip: some View {
        HStack(spacing: 4) {
            ForEach(visibleTabs) { tab in
                tabButton(tab)
            }
            gearButton
        }
        .padding(4)
        .glassEffect(.regular, in: .capsule)
    }

    /// Opens the standard Settings window (all settings live there).
    private var gearButton: some View {
        Button {
            Haptics.tap(.levelChange)
            // An accessory app isn't frontmost when the notch panel is clicked, so
            // openSettings() alone leaves the window buried or unshown. Activate
            // first to reliably surface it (mirrors the status-item menu path).
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 46, height: 32)
                .foregroundStyle(Color.white.opacity(0.5))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Settings")
    }

    private var visibleTabs: [NotchState.ExpandedTab] {
        NotchState.ExpandedTab.allCases.filter { $0 != .agents || settings.agentsEnabled }
    }

    private func tabButton(_ tab: NotchState.ExpandedTab) -> some View {
        let selected = state.expandedTab == tab
        return Button {
            Haptics.tap(.levelChange)
            state.select(tab: tab)
        } label: {
            Image(systemName: tab.symbol)
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 46, height: 32)
                .foregroundStyle(selected ? Color.white : Color.white.opacity(0.5))
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
    }

    // MARK: - Body

    @ViewBuilder
    private var content: some View {
        if state.isDropActive {
            DropChooserView()
        } else {
            switch state.expandedTab {
            case .home:
                home
            case .agents:
                AgentsView()
            case .media:
                MediaPlayerView(namespace: namespace)
            case .tray:
                TrayView()
            }
        }
    }

    private var home: some View {
        // The compact pill already surfaces transient activities, so home stays a
        // clean, fixed-height dashboard.
        WidgetGridView()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
