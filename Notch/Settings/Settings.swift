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
        static let agentCodexEnabled = "agentCodexEnabled"
        static let agentOpenCodeEnabled = "agentOpenCodeEnabled"
        static let agentOhMyPiEnabled = "agentOhMyPiEnabled"
        static let agentNotifyStarted = "agentNotifyStarted"
        static let agentNotifyAttention = "agentNotifyAttention"
        static let agentNotifyFinished = "agentNotifyFinished"
        static let agentAutoExpandOnAttention = "agentAutoExpandOnAttention"
        static let agentSystemNotifications = "agentSystemNotifications"
        static let agentNotifySound = "agentNotifySound"
        static let agentSoundStarted = "agentSoundStarted"
        static let agentSoundAttention = "agentSoundAttention"
        static let agentSoundFinished = "agentSoundFinished"
        static let agentUsageLimits = "agentUsageLimits"
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
    @Published var agentCodexEnabled: Bool { didSet { defaults.set(agentCodexEnabled, forKey: Key.agentCodexEnabled) } }
    @Published var agentOpenCodeEnabled: Bool { didSet { defaults.set(agentOpenCodeEnabled, forKey: Key.agentOpenCodeEnabled) } }
    @Published var agentOhMyPiEnabled: Bool { didSet { defaults.set(agentOhMyPiEnabled, forKey: Key.agentOhMyPiEnabled) } }
    @Published var agentNotifyStarted: Bool { didSet { defaults.set(agentNotifyStarted, forKey: Key.agentNotifyStarted) } }
    @Published var agentNotifyAttention: Bool { didSet { defaults.set(agentNotifyAttention, forKey: Key.agentNotifyAttention) } }
    @Published var agentNotifyFinished: Bool { didSet { defaults.set(agentNotifyFinished, forKey: Key.agentNotifyFinished) } }
    @Published var agentAutoExpandOnAttention: Bool { didSet { defaults.set(agentAutoExpandOnAttention, forKey: Key.agentAutoExpandOnAttention) } }
    @Published var agentSystemNotifications: Bool { didSet { defaults.set(agentSystemNotifications, forKey: Key.agentSystemNotifications) } }
    @Published var agentNotifySound: Bool { didSet { defaults.set(agentNotifySound, forKey: Key.agentNotifySound) } }
    @Published var agentSoundStarted: String { didSet { defaults.set(agentSoundStarted, forKey: Key.agentSoundStarted) } }
    @Published var agentSoundAttention: String { didSet { defaults.set(agentSoundAttention, forKey: Key.agentSoundAttention) } }
    @Published var agentSoundFinished: String { didSet { defaults.set(agentSoundFinished, forKey: Key.agentSoundFinished) } }
    @Published var agentUsageLimits: Bool { didSet { defaults.set(agentUsageLimits, forKey: Key.agentUsageLimits) } }

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
            Key.agentCodexEnabled: false,
            Key.agentOpenCodeEnabled: false,
            Key.agentOhMyPiEnabled: false,
            Key.agentNotifyStarted: false,
            Key.agentNotifyAttention: true,
            Key.agentNotifyFinished: true,
            Key.agentAutoExpandOnAttention: false,
            Key.agentSystemNotifications: false,
            Key.agentNotifySound: false,
            Key.agentSoundStarted: "",
            Key.agentSoundAttention: "Ping",
            Key.agentSoundFinished: "Glass",
            Key.agentUsageLimits: false,
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
        self.agentCodexEnabled = defaults.bool(forKey: Key.agentCodexEnabled)
        self.agentOpenCodeEnabled = defaults.bool(forKey: Key.agentOpenCodeEnabled)
        self.agentOhMyPiEnabled = defaults.bool(forKey: Key.agentOhMyPiEnabled)
        self.agentNotifyStarted = defaults.bool(forKey: Key.agentNotifyStarted)
        self.agentNotifyAttention = defaults.bool(forKey: Key.agentNotifyAttention)
        self.agentNotifyFinished = defaults.bool(forKey: Key.agentNotifyFinished)
        self.agentAutoExpandOnAttention = defaults.bool(forKey: Key.agentAutoExpandOnAttention)
        self.agentSystemNotifications = defaults.bool(forKey: Key.agentSystemNotifications)
        self.agentNotifySound = defaults.bool(forKey: Key.agentNotifySound)
        self.agentSoundStarted = defaults.string(forKey: Key.agentSoundStarted) ?? ""
        self.agentSoundAttention = defaults.string(forKey: Key.agentSoundAttention) ?? "Ping"
        self.agentSoundFinished = defaults.string(forKey: Key.agentSoundFinished) ?? "Glass"
        self.agentUsageLimits = defaults.bool(forKey: Key.agentUsageLimits)
    }
}
