import SwiftUI

/// The expanded home surface, laid out as Notification-Center-style tiles: a
/// narrow column of status tiles (battery / focus / bluetooth) beside a wider
/// column of info panels (weather / calendar). Each tile owns its own glass
/// chrome and fills its cell, so the grid only arranges them and gates the
/// optional cells behind their settings / availability.
struct WidgetGridView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var bluetooth: BluetoothBatteryManager
    @EnvironmentObject private var focus: FocusManager

    private var hasInfoColumn: Bool {
        settings.showWeatherWidget || settings.showCalendarWidget
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            statusColumn
                .frame(width: hasInfoColumn ? 150 : nil)
                .frame(maxWidth: hasInfoColumn ? nil : .infinity, alignment: .leading)

            if hasInfoColumn {
                infoColumn
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear {
            bluetooth.refresh()
            focus.refresh()
        }
    }

    private var statusColumn: some View {
        VStack(spacing: 10) {
            BatteryWidgetView()
            FocusWidgetView()
            if !bluetooth.devices.isEmpty {
                BluetoothWidgetView()
            }
        }
    }

    private var infoColumn: some View {
        VStack(spacing: 10) {
            if settings.showWeatherWidget {
                WeatherWidgetView()
            }
            if settings.showCalendarWidget {
                CalendarWidgetView()
            }
        }
    }
}
