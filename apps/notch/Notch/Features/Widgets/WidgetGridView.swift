import NotchCore
import SwiftUI

/// The expanded home dashboard: a compact row of status tiles above a wider row
/// of info panels, both driven by the ordered `Settings.widgetLayout`. Purely a
/// display surface: which widgets show, and in what order, is decided in the
/// Settings window's Widgets tab, so the home tab carries no editing chrome.
struct WidgetGridView: View {
    @Environment(Settings.self) private var settings
    @Environment(BluetoothBatteryManager.self) private var bluetooth
    @Environment(FocusManager.self) private var focus
    @Environment(WeatherManager.self) private var weather
    @Environment(CalendarManager.self) private var calendar
    @Environment(BatteryManager.self) private var battery
    @Environment(NotchState.self) private var state
    @Environment(\.openSettings) private var openSettings

    @Environment(\.notchDisplayKey) private var displayKey

    private let spacing: CGFloat = 10

    var body: some View {
        VStack(spacing: spacing) {
            liveGrid
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear {
            bluetooth.refresh()
            focus.refresh()
            weather.refresh()
            calendar.refresh()
        }
    }

    // MARK: - Live widgets

    @ViewBuilder
    private var liveGrid: some View {
        let status = visibleKinds(in: .status)
        let info = visibleKinds(in: .info)

        if !status.isEmpty {
            HStack(spacing: spacing) {
                ForEach(status) { widgetView($0) }
            }
            .frame(height: 80)
        }
        if info.isEmpty {
            emptyHint
                .frame(maxHeight: .infinity)
        } else {
            HStack(spacing: spacing) {
                ForEach(info) { widgetView($0) }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func visibleKinds(in row: WidgetKind.Row) -> [WidgetKind] {
        settings.widgetLayout(for: displayKey).filter { $0.row == row && isAvailable($0) }
    }

    /// Hardware-bound tiles stay in the layout but only render when the machine
    /// actually has something to show.
    private func isAvailable(_ kind: WidgetKind) -> Bool {
        switch kind {
        case .battery: battery.hasBattery
        case .bluetooth: !bluetooth.devices.isEmpty
        default: true
        }
    }

    @ViewBuilder
    private func widgetView(_ kind: WidgetKind) -> some View {
        switch kind {
        case .battery: BatteryWidgetView()
        case .clock: ClockWidgetView()
        case .focus: FocusWidgetView()
        case .bluetooth: BluetoothWidgetView()
        case .weather: WeatherWidgetView()
        case .calendar: CalendarWidgetView()
        case .shortcuts: ShortcutsWidgetView()
        case .note: NoteWidgetView()
        }
    }

    private var emptyHint: some View {
        Button {
            Haptics.tap(.levelChange)
            // Settings replaces the notch as the active surface; collapse first
            // and activate, as the shoulder tabs do, or the window stays buried.
            state.collapseImmediately()
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        } label: {
            VStack(spacing: 6) {
                PixelIcon(
                    systemName: "square.grid.2x2",
                    size: 22,
                    tint: .white.opacity(0.4)
                )
                Text("No widgets enabled")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
                Text("Choose widgets in Settings > Widgets.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.45))
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}
