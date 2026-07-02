import SwiftUI

/// The expanded home dashboard: a compact row of status tiles (battery / focus /
/// bluetooth) above a wider row of info panels (weather / calendar). Each tile
/// owns its own glass chrome and fills its cell, so this view only arranges them
/// and gates the optional cells behind their settings / availability.
struct WidgetGridView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var bluetooth: BluetoothBatteryManager
    @EnvironmentObject private var focus: FocusManager
    @EnvironmentObject private var weather: WeatherManager

    private var hasInfoRow: Bool {
        settings.showWeatherWidget || settings.showCalendarWidget
    }

    var body: some View {
        VStack(spacing: 10) {
            statusRow
                .frame(height: 80)

            if hasInfoRow {
                infoRow
                    .frame(maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear {
            bluetooth.refresh()
            focus.refresh()
            weather.refresh()
        }
    }

    private var statusRow: some View {
        HStack(spacing: 10) {
            BatteryWidgetView()
            FocusWidgetView()
            if !bluetooth.devices.isEmpty {
                BluetoothWidgetView()
            }
        }
    }

    private var infoRow: some View {
        HStack(spacing: 10) {
            if settings.showWeatherWidget {
                WeatherWidgetView()
            }
            if settings.showCalendarWidget {
                CalendarWidgetView()
            }
        }
    }
}
