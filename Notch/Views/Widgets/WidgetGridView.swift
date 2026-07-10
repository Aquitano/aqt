import SwiftUI

/// The expanded home dashboard: a compact row of status tiles (battery / clock /
/// focus / bluetooth) above a wider row of info panels (weather / calendar /
/// shortcuts / note). Each tile owns its own glass chrome and fills its cell, so
/// this view only arranges them and gates the optional cells behind their
/// settings / availability.
struct WidgetGridView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var bluetooth: BluetoothBatteryManager
    @EnvironmentObject private var focus: FocusManager
    @EnvironmentObject private var weather: WeatherManager
    @EnvironmentObject private var calendar: CalendarManager
    @EnvironmentObject private var battery: BatteryManager

    private var hasInfoRow: Bool {
        settings.hasInfoRowWidgets
    }

    var body: some View {
        VStack(spacing: 10) {
            statusRow
                .frame(height: 80)

            if hasInfoRow {
                infoRow
                    .frame(maxHeight: .infinity)
            } else {
                emptyHint
                    .frame(maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear {
            bluetooth.refresh()
            focus.refresh()
            weather.refresh()
            calendar.refresh()
        }
    }

    private var statusRow: some View {
        HStack(spacing: 10) {
            if battery.hasBattery {
                BatteryWidgetView()
            }
            if settings.showClockWidget {
                ClockWidgetView()
            }
            FocusWidgetView()
            if !bluetooth.devices.isEmpty {
                BluetoothWidgetView()
            }
        }
    }

    private var emptyHint: some View {
        VStack(spacing: 6) {
            PixelIcon(systemName: "square.grid.2x2", size: 22,
                      tint: .white.opacity(0.4))
            Text("No widgets enabled")
                .font(.body.weight(.semibold))
                .foregroundStyle(.white.opacity(0.7))
            Text("Turn on Weather, Calendar, Shortcuts, or a note in Settings to fill this space.")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.45))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    private var infoRow: some View {
        HStack(spacing: 10) {
            if settings.showWeatherWidget {
                WeatherWidgetView()
            }
            if settings.showCalendarWidget {
                CalendarWidgetView()
            }
            if settings.showShortcutsWidget {
                ShortcutsWidgetView()
            }
            if settings.showNoteWidget {
                NoteWidgetView()
            }
        }
    }
}
