import SwiftUI

/// One home-tab widget. The ordered list in `Settings.widgetLayout` is the
/// single source of truth for which widgets show and in what order; a kind's
/// `row` decides which of the two grid rows it renders in.
enum WidgetKind: String, CaseIterable, Identifiable, Codable {
    case battery, clock, focus, bluetooth
    case weather, calendar, shortcuts, note

    enum Row {
        /// Compact 80pt tiles along the top.
        case status
        /// Taller info panels below.
        case info
    }

    var id: String { rawValue }

    var row: Row {
        switch self {
        case .battery, .clock, .focus, .bluetooth: .status
        case .weather, .calendar, .shortcuts, .note: .info
        }
    }

    var title: String {
        switch self {
        case .battery: "Battery"
        case .clock: "Clock"
        case .focus: "Focus"
        case .bluetooth: "Bluetooth"
        case .weather: "Weather"
        case .calendar: "Calendar"
        case .shortcuts: "Shortcuts"
        case .note: "Quick note"
        }
    }

    var subtitle: String {
        switch self {
        case .battery: "Charge and Low Power Mode"
        case .clock: "Time and a second zone"
        case .focus: "Current Focus state"
        case .bluetooth: "Connected device batteries"
        case .weather: "Conditions and temperature"
        case .calendar: "Upcoming events"
        case .shortcuts: "Pinned quick actions"
        case .note: "Scratch text on the home tab"
        }
    }

    var symbol: String {
        switch self {
        case .battery: "battery.75percent"
        case .clock: "clock"
        case .focus: "moon"
        case .bluetooth: "wave.3.right"
        case .weather: "cloud.sun.fill"
        case .calendar: "calendar"
        case .shortcuts: "sparkles"
        case .note: "note.text"
        }
    }

    var tint: Color {
        switch self {
        case .battery: .green
        case .clock: .indigo
        case .focus: .blue
        case .bluetooth: .teal
        case .weather: .cyan
        case .calendar: .red
        case .shortcuts: .purple
        case .note: .yellow
        }
    }

    /// Matches the pre-layout behavior: hardware tiles plus weather/calendar on,
    /// clock/shortcuts/note off.
    static let defaultLayout: [WidgetKind] = [
        .battery, .focus, .bluetooth, .weather, .calendar,
    ]
}
