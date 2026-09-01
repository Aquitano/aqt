import Foundation

struct CalendarEvent: Identifiable, Equatable {
    let id: String
    var title: String
    var start: Date
    var end: Date
    var isAllDay: Bool
    var calendarColorHex: String?
    var location: String?
    /// First detected video-call URL, for a join-meeting button.
    var conferenceURL: URL?

    var isInProgress: Bool {
        let now = Date()
        return start <= now && now < end
    }
}

/// Current conditions + a short daily outlook from Open-Meteo.
struct WeatherSnapshot: Equatable {
    var temperature: Double          // in the user's unit
    var apparentTemperature: Double?
    var weatherCode: Int             // WMO code
    var isDay: Bool
    var symbolName: String           // our own SF Symbol mapping
    var conditionText: String
    var locationName: String?
    var unit: TemperatureUnit
    var daily: [WeatherDay]

    enum TemperatureUnit: String, Codable { case celsius, fahrenheit
        var suffix: String { self == .celsius ? "°C" : "°F" }
    }
}

struct WeatherDay: Identifiable, Equatable {
    var id: Date { date }
    var date: Date
    var high: Double
    var low: Double
    var weatherCode: Int
    var symbolName: String
}

/// A Bluetooth device with whatever battery info we could resolve.
struct BluetoothDevice: Identifiable, Equatable {
    let id: String                   // address or registry id
    var name: String
    var symbol: String
    var batteryMain: Int?
    var batteryLeft: Int?
    var batteryRight: Int?
    var batteryCase: Int?
    var isConnected: Bool
}

/// How the tray's share zone hands a dropped file off. AirDrop uses the native
