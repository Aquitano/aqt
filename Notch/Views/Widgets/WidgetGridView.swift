import SwiftUI

/// Row of small at-a-glance widgets shown on the expanded home surface. Each
/// widget owns its own glass chrome, so this view only arranges them and gates
/// the optional cells behind their settings / availability. Lives inside the
/// expanded panel, so it never renders while the notch is idle.
struct WidgetGridView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var bluetooth: BluetoothBatteryManager
    @EnvironmentObject private var focus: FocusManager

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            BatteryWidgetView()

            if settings.showCalendarWidget {
                CalendarWidgetView()
            }

            if settings.showWeatherWidget {
                WeatherWidgetView()
            }

            FocusWidgetView()

            if !bluetooth.devices.isEmpty {
                BluetoothWidgetView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            bluetooth.refresh()
            focus.refresh()
        }
    }
}
