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
        static let showCompactNowPlaying = "showCompactNowPlaying"
        static let showAudioVisualizer = "showAudioVisualizer"
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
        static let agentPermissionApproval = "agentPermissionApproval"
        static let hasCompletedOnboarding = "hasCompletedOnboarding"
        static let hotkeyEnabled = "hotkeyEnabled"
        static let hotkeyKeyCode = "hotkeyKeyCode"
        static let hotkeyModifiers = "hotkeyModifiers"
        static let showClockWidget = "showClockWidget"
        static let clockSecondaryTimeZone = "clockSecondaryTimeZone"
        static let showShortcutsWidget = "showShortcutsWidget"
        static let pinnedShortcuts = "pinnedShortcuts"
        static let showNoteWidget = "showNoteWidget"
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
    @Published var showCompactNowPlaying: Bool {
        didSet { defaults.set(showCompactNowPlaying, forKey: Key.showCompactNowPlaying) }
    }
    @Published var showAudioVisualizer: Bool {
        didSet { defaults.set(showAudioVisualizer, forKey: Key.showAudioVisualizer) }
    }
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
    @Published var agentPermissionApproval: Bool { didSet { defaults.set(agentPermissionApproval, forKey: Key.agentPermissionApproval) } }
    @Published var hasCompletedOnboarding: Bool { didSet { defaults.set(hasCompletedOnboarding, forKey: Key.hasCompletedOnboarding) } }
    @Published var hotkeyEnabled: Bool { didSet { defaults.set(hotkeyEnabled, forKey: Key.hotkeyEnabled) } }
    /// Carbon virtual key code + modifier mask for the toggle-notch hotkey. No
    /// recording UI yet; changeable via `defaults write` until one exists.
    @Published var hotkeyKeyCode: Int { didSet { defaults.set(hotkeyKeyCode, forKey: Key.hotkeyKeyCode) } }
    @Published var hotkeyModifiers: Int { didSet { defaults.set(hotkeyModifiers, forKey: Key.hotkeyModifiers) } }
    @Published var showClockWidget: Bool { didSet { defaults.set(showClockWidget, forKey: Key.showClockWidget) } }
    /// Time-zone identifier for the clock tile's second line; empty = none.
    @Published var clockSecondaryTimeZone: String { didSet { defaults.set(clockSecondaryTimeZone, forKey: Key.clockSecondaryTimeZone) } }
    @Published var showShortcutsWidget: Bool { didSet { defaults.set(showShortcutsWidget, forKey: Key.showShortcutsWidget) } }
    @Published var pinnedShortcuts: [String] { didSet { defaults.set(pinnedShortcuts, forKey: Key.pinnedShortcuts) } }
    @Published var showNoteWidget: Bool { didSet { defaults.set(showNoteWidget, forKey: Key.showNoteWidget) } }

    /// Widgets occupying the expanded home's info row. Drives both the grid and
    /// the panel height, so the two can never disagree about an empty row.
    var hasInfoRowWidgets: Bool {
        showWeatherWidget || showCalendarWidget || showShortcutsWidget || showNoteWidget
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.showHUD: true,
            Key.temperatureUnit: WeatherSnapshot.TemperatureUnit.celsius.rawValue,
            Key.launchAtLogin: false,
            Key.enableMediaAdapter: true,
            Key.showCompactNowPlaying: true,
            // Capturing real system-audio levels requires an explicit privacy grant.
            // Keep it opt-in so an update never surprises the user with a prompt.
            Key.showAudioVisualizer: false,
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
            Key.agentSoundStarted: AgentSound.boot.rawValue,
            Key.agentSoundAttention: AgentSound.alert.rawValue,
            Key.agentSoundFinished: AgentSound.complete.rawValue,
            Key.agentUsageLimits: false,
            Key.agentPermissionApproval: false,
            Key.hasCompletedOnboarding: false,
            Key.hotkeyEnabled: false,
            Key.hotkeyKeyCode: 45,       // kVK_ANSI_N
            Key.hotkeyModifiers: 6144,   // controlKey | optionKey
            Key.showClockWidget: false,
            Key.clockSecondaryTimeZone: "",
            Key.showShortcutsWidget: false,
            Key.pinnedShortcuts: [String](),
            Key.showNoteWidget: false,
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
        self.showCompactNowPlaying = defaults.bool(forKey: Key.showCompactNowPlaying)
        self.showAudioVisualizer = defaults.bool(forKey: Key.showAudioVisualizer)
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
        self.agentSoundStarted = AgentSound.normalizedName(
            defaults.string(forKey: Key.agentSoundStarted), fallback: .boot
        )
        self.agentSoundAttention = AgentSound.normalizedName(
            defaults.string(forKey: Key.agentSoundAttention), fallback: .alert
        )
        self.agentSoundFinished = AgentSound.normalizedName(
            defaults.string(forKey: Key.agentSoundFinished), fallback: .complete
        )
        self.agentUsageLimits = defaults.bool(forKey: Key.agentUsageLimits)
        self.agentPermissionApproval = defaults.bool(forKey: Key.agentPermissionApproval)
        self.hasCompletedOnboarding = defaults.bool(forKey: Key.hasCompletedOnboarding)
        self.hotkeyEnabled = defaults.bool(forKey: Key.hotkeyEnabled)
        self.hotkeyKeyCode = defaults.integer(forKey: Key.hotkeyKeyCode)
        self.hotkeyModifiers = defaults.integer(forKey: Key.hotkeyModifiers)
        self.showClockWidget = defaults.bool(forKey: Key.showClockWidget)
        self.clockSecondaryTimeZone = defaults.string(forKey: Key.clockSecondaryTimeZone) ?? ""
        self.showShortcutsWidget = defaults.bool(forKey: Key.showShortcutsWidget)
        self.pinnedShortcuts = defaults.stringArray(forKey: Key.pinnedShortcuts) ?? []
        self.showNoteWidget = defaults.bool(forKey: Key.showNoteWidget)
    }
}
