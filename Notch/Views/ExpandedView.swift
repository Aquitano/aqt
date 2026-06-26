import SwiftUI

/// The full expanded panel body. Lives inside the black notch blob, so every
/// chrome surface here is glass-on-black (never glass on the pill itself). A
/// single `GlassEffectContainer` lets the tab strip and the cards below it
/// blend as one liquid-glass system.
struct ExpandedView: View {
    let namespace: Namespace.ID

    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var activities: ActivityManager
    @EnvironmentObject private var settings: Settings

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.openSettings) private var openSettings

    @Namespace private var tabNamespace

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            VStack(spacing: 12) {
                tabStrip
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
            // Keep all content clear of the physical notch / camera band.
            .padding(.top, notchSize.height + 8)
        }
        .foregroundStyle(.white)
        .tint(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Tab strip

    private var tabStrip: some View {
        HStack(spacing: 4) {
            ForEach(NotchState.ExpandedTab.allCases) { tab in
                tabButton(tab)
            }
        }
        .padding(4)
        .glassEffect(.regular, in: .capsule)
    }

    private func tabButton(_ tab: NotchState.ExpandedTab) -> some View {
        let selected = state.expandedTab == tab
        return Button {
            Haptics.tap(.levelChange)
            state.select(tab: tab)
        } label: {
            Image(systemName: tab.symbol)
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 38, height: 28)
                .foregroundStyle(selected ? Color.white : Color.white.opacity(0.5))
                .background {
                    // One shared pill that slides between tabs as the selection moves.
                    if selected {
                        RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
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
        switch state.expandedTab {
        case .home:
            home
        case .media:
            MediaPlayerView(namespace: namespace)
        case .tray:
            TrayView()
        case .settings:
            settingsPanel
        }
    }

    @ViewBuilder
    private var home: some View {
        VStack(spacing: 10) {
            WidgetGridView()

            if let activity = activities.ordered.first {
                ActivityCardView(activity: activity, namespace: namespace)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Inline settings

    private var settingsPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Show HUD", isOn: $settings.showHUD)
            Toggle("Weather widget", isOn: $settings.showWeatherWidget)
            Toggle("Calendar widget", isOn: $settings.showCalendarWidget)
            Toggle("Launch at login", isOn: $settings.launchAtLogin)

            Button("Open Settings…") { openSettings() }
                .buttonStyle(.plain)
                .font(.callout.weight(.medium))
                .foregroundStyle(.white.opacity(0.8))
                .padding(.top, 2)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
