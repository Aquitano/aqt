import Foundation

/// A calendar event, flattened from EventKit so views never touch EKEvent.
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
/// share sheet; Blip is matched by name among the system sharing services.
enum ShareMethod: String, CaseIterable, Identifiable, Codable {
    case airdrop
    case blip

    var id: String { rawValue }

    /// Name shown in Settings.
    var title: String {
        switch self {
        case .airdrop: return "AirDrop"
        case .blip: return "Blip"
        }
    }

    /// Label on the drop zone.
    var actionTitle: String {
        switch self {
        case .airdrop: return "AirDrop"
        case .blip: return "Send with Blip"
        }
    }

    var symbol: String {
        switch self {
        case .airdrop: return "airdrop"
        case .blip: return "paperplane.fill"
        }
    }

    /// Substring used to locate the service in `NSSharingService.sharingServices`.
    /// AirDrop has a named constant and skips this.
    var serviceMatch: String { "blip" }
}

/// Where the expanded panel's section switcher renders. Only `.inside` spends a
/// row of the body on itself; the other two draw outside it, so the blob gives
/// that row back to the content.
enum TabBarStyle: String, CaseIterable, Identifiable {
    /// Detached capsule below the blob, Dynamic-Island style.
    case floating
    /// Glass strip inside the blob, above the body.
    case inside
    /// Icons straight on the black band flanking the physical cutout.
    case shoulders

    var id: String { rawValue }

    /// Name shown in Settings.
    var title: String {
        switch self {
        case .floating: return "Floating below the notch"
        case .inside: return "Inside the panel"
        case .shoulders: return "On the notch shoulders"
        }
    }
}

/// What a HUD overlay is currently reporting.
enum HUDKind: Equatable {
    case volume
    case brightness
    case mute

    var symbol: String {
        switch self {
        case .volume: return "speaker.wave.2.fill"
        case .brightness: return "sun.max.fill"
        case .mute: return "speaker.slash.fill"
        }
    }

    /// Short name shown beside the glyph in the HUD capsule.
    var title: String {
        switch self {
        case .volume: return "Volume"
        case .brightness: return "Display"
        case .mute: return "Muted"
        }
    }
}
