import SwiftUI
import Combine

/// User-facing preferences. Backed by UserDefaults; each property publishes so
/// the UI and managers react live. Kept deliberately small for v1.
@MainActor
final class Settings: ObservableObject {

    static let shared = Settings()

    private let defaults: UserDefaults
    private enum Key {
        static let showHUD = "showHUD"
        static let temperatureUnit = "temperatureUnit"
        static let launchAtLogin = "launchAtLogin"
        static let enableMediaAdapter = "enableMediaAdapter"
        static let hapticFeedback = "hapticFeedback"
        static let trayTTLDays = "trayTTLDays"
        static let showWeatherWidget = "showWeatherWidget"
        static let showCalendarWidget = "showCalendarWidget"
        static let shareMethod = "shareMethod"
    }

    @Published var showHUD: Bool { didSet { defaults.set(showHUD, forKey: Key.showHUD) } }
    @Published var temperatureUnit: WeatherSnapshot.TemperatureUnit {
        didSet { defaults.set(temperatureUnit.rawValue, forKey: Key.temperatureUnit) }
    }
    @Published var launchAtLogin: Bool {
        didSet {
            defaults.set(launchAtLogin, forKey: Key.launchAtLogin)
            LoginItem.setEnabled(launchAtLogin)
        }
    }
    @Published var enableMediaAdapter: Bool { didSet { defaults.set(enableMediaAdapter, forKey: Key.enableMediaAdapter) } }
    @Published var hapticFeedback: Bool { didSet { defaults.set(hapticFeedback, forKey: Key.hapticFeedback) } }
    @Published var trayTTLDays: Int { didSet { defaults.set(trayTTLDays, forKey: Key.trayTTLDays) } }
    @Published var showWeatherWidget: Bool { didSet { defaults.set(showWeatherWidget, forKey: Key.showWeatherWidget) } }
    @Published var showCalendarWidget: Bool { didSet { defaults.set(showCalendarWidget, forKey: Key.showCalendarWidget) } }
    @Published var shareMethod: ShareMethod { didSet { defaults.set(shareMethod.rawValue, forKey: Key.shareMethod) } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.showHUD: true,
            Key.temperatureUnit: WeatherSnapshot.TemperatureUnit.celsius.rawValue,
            Key.launchAtLogin: false,
            Key.enableMediaAdapter: true,
            Key.hapticFeedback: true,
            Key.trayTTLDays: 7,
            Key.showWeatherWidget: true,
            Key.showCalendarWidget: true,
            Key.shareMethod: ShareMethod.airdrop.rawValue,
        ])
        self.showHUD = defaults.bool(forKey: Key.showHUD)
        self.temperatureUnit = WeatherSnapshot.TemperatureUnit(
            rawValue: defaults.string(forKey: Key.temperatureUnit) ?? "celsius"
        ) ?? .celsius
        // Trust the OS registration over the stored bool so a login item the user
        // removed in System Settings isn't silently re-shown as enabled. didSet does
        // not fire during init, so reading this never triggers a register() call.
        self.launchAtLogin = LoginItem.isEnabled
        self.enableMediaAdapter = defaults.bool(forKey: Key.enableMediaAdapter)
        self.hapticFeedback = defaults.bool(forKey: Key.hapticFeedback)
        self.trayTTLDays = defaults.integer(forKey: Key.trayTTLDays)
        self.showWeatherWidget = defaults.bool(forKey: Key.showWeatherWidget)
        self.showCalendarWidget = defaults.bool(forKey: Key.showCalendarWidget)
        self.shareMethod = ShareMethod(rawValue: defaults.string(forKey: Key.shareMethod) ?? "airdrop") ?? .airdrop
    }
}
