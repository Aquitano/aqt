import Foundation

package struct CalendarEvent: Identifiable, Equatable {
    package let id: String
    package var title: String
    package var start: Date
    package var end: Date
    package var isAllDay: Bool
    package var calendarColorHex: String?
    package var location: String?
    /// First detected video-call URL, for a join-meeting button.
    package var conferenceURL: URL?

    package init(
        id: String,
        title: String,
        start: Date,
        end: Date,
        isAllDay: Bool,
        calendarColorHex: String? = nil,
        location: String? = nil,
        conferenceURL: URL? = nil
    ) {
        self.id = id
        self.title = title
        self.start = start
        self.end = end
        self.isAllDay = isAllDay
        self.calendarColorHex = calendarColorHex
        self.location = location
        self.conferenceURL = conferenceURL
    }

    package var isInProgress: Bool {
        let now = Date()
        return start <= now && now < end
    }
}

/// Current conditions + a short daily outlook from Open-Meteo.
package struct WeatherSnapshot: Equatable {
    package var temperature: Double // in the user's unit
    package var apparentTemperature: Double?
    package var weatherCode: Int // WMO code
    package var isDay: Bool
    package var symbolName: String // our own SF Symbol mapping
    package var conditionText: String
    package var locationName: String?
    package var unit: TemperatureUnit
    package var daily: [WeatherDay]

    package init(
        temperature: Double,
        apparentTemperature: Double? = nil,
        weatherCode: Int,
        isDay: Bool,
        symbolName: String,
        conditionText: String,
        locationName: String? = nil,
        unit: TemperatureUnit,
        daily: [WeatherDay]
    ) {
        self.temperature = temperature
        self.apparentTemperature = apparentTemperature
        self.weatherCode = weatherCode
        self.isDay = isDay
        self.symbolName = symbolName
        self.conditionText = conditionText
        self.locationName = locationName
        self.unit = unit
        self.daily = daily
    }

    package enum TemperatureUnit: String, Codable { case celsius, fahrenheit
        package var suffix: String {
            self == .celsius ? "°C" : "°F"
        }
    }
}

package struct WeatherDay: Identifiable, Equatable {
    package var id: Date {
        date
    }

    package var date: Date
    package var high: Double
    package var low: Double
    package var weatherCode: Int
    package var symbolName: String

    package init(date: Date, high: Double, low: Double, weatherCode: Int, symbolName: String) {
        self.date = date
        self.high = high
        self.low = low
        self.weatherCode = weatherCode
        self.symbolName = symbolName
    }
}

/// A Bluetooth device with whatever battery info we could resolve.
package struct BluetoothDevice: Identifiable, Equatable {
    package let id: String // address or registry id
    package var name: String
    package var symbol: String
    package var batteryMain: Int?
    package var batteryLeft: Int?
    package var batteryRight: Int?
    package var batteryCase: Int?
    package var isConnected: Bool

    package init(
        id: String,
        name: String,
        symbol: String,
        batteryMain: Int? = nil,
        batteryLeft: Int? = nil,
        batteryRight: Int? = nil,
        batteryCase: Int? = nil,
        isConnected: Bool
    ) {
        self.id = id
        self.name = name
        self.symbol = symbol
        self.batteryMain = batteryMain
        self.batteryLeft = batteryLeft
        self.batteryRight = batteryRight
        self.batteryCase = batteryCase
        self.isConnected = isConnected
    }
}

// How the tray's share zone hands a dropped file off. AirDrop uses the native
