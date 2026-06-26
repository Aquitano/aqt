import SwiftUI

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

    private var home: some View {
        // The compact pill already surfaces transient activities, so home stays a
        // clean, fixed-height dashboard.
        WidgetGridView()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Inline settings

    private var settingsPanel: some View {
        VStack(spacing: 2) {
            settingsToggle("Show HUD", $settings.showHUD)
            settingsToggle("Weather widget", $settings.showWeatherWidget)
            settingsToggle("Calendar widget", $settings.showCalendarWidget)
            settingsToggle("Launch at login", $settings.launchAtLogin)

            Divider()
                .overlay(.white.opacity(0.12))
                .padding(.vertical, 6)

            Button {
                openSettings()
            } label: {
                HStack(spacing: 8) {
                    Text("All Settings…")
                        .font(.system(size: 13, weight: .medium))
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.forward")
                        .font(.system(size: 11, weight: .semibold))
                }
                .foregroundStyle(.white.opacity(0.85))
                .frame(maxWidth: .infinity, minHeight: 30)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func settingsToggle(_ title: String, _ isOn: Binding<Bool>) -> some View {
        SettingRow(title: title) {
            Toggle("", isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }
}
