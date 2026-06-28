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
        static let agentsEnabled = "agentsEnabled"
        static let agentClaudeEnabled = "agentClaudeEnabled"
        static let agentNotifyStarted = "agentNotifyStarted"
        static let agentNotifyAttention = "agentNotifyAttention"
        static let agentNotifyFinished = "agentNotifyFinished"
        static let agentAutoExpandOnAttention = "agentAutoExpandOnAttention"
        static let agentSystemNotifications = "agentSystemNotifications"
        static let agentNotifySound = "agentNotifySound"
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
    @Published var agentsEnabled: Bool { didSet { defaults.set(agentsEnabled, forKey: Key.agentsEnabled) } }
    @Published var agentClaudeEnabled: Bool { didSet { defaults.set(agentClaudeEnabled, forKey: Key.agentClaudeEnabled) } }
    @Published var agentNotifyStarted: Bool { didSet { defaults.set(agentNotifyStarted, forKey: Key.agentNotifyStarted) } }
    @Published var agentNotifyAttention: Bool { didSet { defaults.set(agentNotifyAttention, forKey: Key.agentNotifyAttention) } }
    @Published var agentNotifyFinished: Bool { didSet { defaults.set(agentNotifyFinished, forKey: Key.agentNotifyFinished) } }
    @Published var agentAutoExpandOnAttention: Bool { didSet { defaults.set(agentAutoExpandOnAttention, forKey: Key.agentAutoExpandOnAttention) } }
    @Published var agentSystemNotifications: Bool { didSet { defaults.set(agentSystemNotifications, forKey: Key.agentSystemNotifications) } }
    @Published var agentNotifySound: Bool { didSet { defaults.set(agentNotifySound, forKey: Key.agentNotifySound) } }

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
            Key.agentsEnabled: true,
            Key.agentClaudeEnabled: false,
            Key.agentNotifyStarted: false,
            Key.agentNotifyAttention: true,
            Key.agentNotifyFinished: true,
            Key.agentAutoExpandOnAttention: false,
            Key.agentSystemNotifications: false,
            Key.agentNotifySound: false,
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
        self.agentsEnabled = defaults.bool(forKey: Key.agentsEnabled)
        self.agentClaudeEnabled = defaults.bool(forKey: Key.agentClaudeEnabled)
        self.agentNotifyStarted = defaults.bool(forKey: Key.agentNotifyStarted)
        self.agentNotifyAttention = defaults.bool(forKey: Key.agentNotifyAttention)
        self.agentNotifyFinished = defaults.bool(forKey: Key.agentNotifyFinished)
        self.agentAutoExpandOnAttention = defaults.bool(forKey: Key.agentAutoExpandOnAttention)
        self.agentSystemNotifications = defaults.bool(forKey: Key.agentSystemNotifications)
        self.agentNotifySound = defaults.bool(forKey: Key.agentNotifySound)
    }
}
