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
        static let hudReplacesSystem = "hudReplacesSystem"
        static let temperatureUnit = "temperatureUnit"
        static let launchAtLogin = "launchAtLogin"
        static let enableMediaAdapter = "enableMediaAdapter"
        static let showCompactNowPlaying = "showCompactNowPlaying"
        static let showAudioVisualizer = "showAudioVisualizer"
        static let hapticFeedback = "hapticFeedback"
        static let trayTTLDays = "trayTTLDays"
        static let trayMoveEnabled = "trayMoveEnabled"
        static let offerScreenshots = "offerScreenshots"
        static let trayLastCollectionID = "trayLastCollectionID"
        static let showWeatherWidget = "showWeatherWidget"
        static let showCalendarWidget = "showCalendarWidget"
        static let shareMethod = "shareMethod"
        static let agentsEnabled = "agentsEnabled"
        static let agentClaudeEnabled = "agentClaudeEnabled"
        static let agentCodexEnabled = "agentCodexEnabled"
        static let agentOpenCodeEnabled = "agentOpenCodeEnabled"
        static let agentOhMyPiEnabled = "agentOhMyPiEnabled"
        static let agentT3Enabled = "agentT3Enabled"
        static let agentT3Environments = "agentT3Environments"
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
        static let pomodoroFocusMinutes = "pomodoroFocusMinutes"
        static let pomodoroBreakMinutes = "pomodoroBreakMinutes"
        static let showClockWidget = "showClockWidget"
        static let clockSecondaryTimeZone = "clockSecondaryTimeZone"
        static let showShortcutsWidget = "showShortcutsWidget"
        static let pinnedShortcuts = "pinnedShortcuts"
        static let showNoteWidget = "showNoteWidget"
        static let displayPlacement = "displayPlacement"
        static let followActiveDisplay = "followActiveDisplay"
        static let virtualNotchMode = "virtualNotchMode"
        static let displayProfiles = "displayProfiles"
    }

    @Published var showHUD: Bool { didSet { defaults.set(showHUD, forKey: Key.showHUD) } }
    /// Consume media keys and suppress the native HUD (needs Accessibility).
    @Published var hudReplacesSystem: Bool { didSet { defaults.set(hudReplacesSystem, forKey: Key.hudReplacesSystem) } }
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
    @Published var trayMoveEnabled: Bool {
        didSet { defaults.set(trayMoveEnabled, forKey: Key.trayMoveEnabled) }
    }
    @Published var offerScreenshots: Bool {
        didSet { defaults.set(offerScreenshots, forKey: Key.offerScreenshots) }
    }
    var trayLastCollectionID: String {
        didSet { defaults.set(trayLastCollectionID, forKey: Key.trayLastCollectionID) }
    }
    @Published var showWeatherWidget: Bool { didSet { defaults.set(showWeatherWidget, forKey: Key.showWeatherWidget) } }
    @Published var showCalendarWidget: Bool { didSet { defaults.set(showCalendarWidget, forKey: Key.showCalendarWidget) } }
    @Published var shareMethod: ShareMethod { didSet { defaults.set(shareMethod.rawValue, forKey: Key.shareMethod) } }
    @Published var agentsEnabled: Bool { didSet { defaults.set(agentsEnabled, forKey: Key.agentsEnabled) } }
    @Published var agentClaudeEnabled: Bool { didSet { defaults.set(agentClaudeEnabled, forKey: Key.agentClaudeEnabled) } }
    @Published var agentCodexEnabled: Bool { didSet { defaults.set(agentCodexEnabled, forKey: Key.agentCodexEnabled) } }
    @Published var agentOpenCodeEnabled: Bool { didSet { defaults.set(agentOpenCodeEnabled, forKey: Key.agentOpenCodeEnabled) } }
    @Published var agentOhMyPiEnabled: Bool { didSet { defaults.set(agentOhMyPiEnabled, forKey: Key.agentOhMyPiEnabled) } }
    @Published var agentT3Enabled: Bool { didSet { defaults.set(agentT3Enabled, forKey: Key.agentT3Enabled) } }
    /// Paired t3 servers (label + base URL); each pairing's bearer token lives
    /// in the Keychain under the environment's `tokenAccount`.
    @Published var agentT3Environments: [T3Environment] {
        didSet {
            defaults.set(try? JSONEncoder().encode(agentT3Environments), forKey: Key.agentT3Environments)
        }
    }
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
    /// Last dial position per pomodoro phase, so the timer tab reopens on the
    /// durations the user actually uses.
    @Published var pomodoroFocusMinutes: Int { didSet { defaults.set(pomodoroFocusMinutes, forKey: Key.pomodoroFocusMinutes) } }
    @Published var pomodoroBreakMinutes: Int { didSet { defaults.set(pomodoroBreakMinutes, forKey: Key.pomodoroBreakMinutes) } }
    @Published var showClockWidget: Bool { didSet { defaults.set(showClockWidget, forKey: Key.showClockWidget) } }
    /// Time-zone identifier for the clock tile's second line; empty = none.
    @Published var clockSecondaryTimeZone: String { didSet { defaults.set(clockSecondaryTimeZone, forKey: Key.clockSecondaryTimeZone) } }
    @Published var showShortcutsWidget: Bool { didSet { defaults.set(showShortcutsWidget, forKey: Key.showShortcutsWidget) } }
    @Published var pinnedShortcuts: [String] { didSet { defaults.set(pinnedShortcuts, forKey: Key.pinnedShortcuts) } }
    @Published var showNoteWidget: Bool { didSet { defaults.set(showNoteWidget, forKey: Key.showNoteWidget) } }
    @Published var displayPlacement: DisplayPlacement {
        didSet { defaults.set(displayPlacement.rawValue, forKey: Key.displayPlacement) }
    }
    @Published var followActiveDisplay: Bool {
        didSet { defaults.set(followActiveDisplay, forKey: Key.followActiveDisplay) }
    }
    @Published var virtualNotchMode: VirtualNotchMode {
        didSet { defaults.set(virtualNotchMode.rawValue, forKey: Key.virtualNotchMode) }
    }
    @Published var displayProfiles: [DisplayProfile] {
        didSet {
            if let data = try? JSONEncoder().encode(displayProfiles) {
                defaults.set(data, forKey: Key.displayProfiles)
            }
        }
    }

    /// Widgets occupying the expanded home's info row. Drives both the grid and
    /// the panel height, so the two can never disagree about an empty row.
    var hasInfoRowWidgets: Bool {
        showWeatherWidget || showCalendarWidget || showShortcutsWidget || showNoteWidget
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.showHUD: true,
            Key.hudReplacesSystem: false,
            Key.temperatureUnit: WeatherSnapshot.TemperatureUnit.celsius.rawValue,
            Key.launchAtLogin: false,
            Key.enableMediaAdapter: true,
            Key.showCompactNowPlaying: true,
            // Capturing real system-audio levels requires an explicit privacy grant.
            // Keep it opt-in so an update never surprises the user with a prompt.
            Key.showAudioVisualizer: false,
            Key.hapticFeedback: true,
            Key.trayTTLDays: 7,
            Key.trayMoveEnabled: false,
            Key.offerScreenshots: false,
            Key.trayLastCollectionID: TrayCollection.shelfID.uuidString,
            Key.showWeatherWidget: true,
            Key.showCalendarWidget: true,
            Key.shareMethod: ShareMethod.airdrop.rawValue,
            Key.agentsEnabled: true,
            Key.agentClaudeEnabled: false,
            Key.agentCodexEnabled: false,
            Key.agentOpenCodeEnabled: false,
            Key.agentOhMyPiEnabled: false,
            Key.agentT3Enabled: false,
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
            Key.pomodoroFocusMinutes: PomodoroPolicy.defaultMinutes(for: .focus),
            Key.pomodoroBreakMinutes: PomodoroPolicy.defaultMinutes(for: .rest),
            Key.showClockWidget: false,
            Key.clockSecondaryTimeZone: "",
            Key.showShortcutsWidget: false,
            Key.pinnedShortcuts: [String](),
            Key.showNoteWidget: false,
            Key.displayPlacement: DisplayPlacement.builtIn.rawValue,
            Key.followActiveDisplay: false,
            Key.virtualNotchMode: VirtualNotchMode.automatic.rawValue,
        ])
        self.showHUD = defaults.bool(forKey: Key.showHUD)
        self.hudReplacesSystem = defaults.bool(forKey: Key.hudReplacesSystem)
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
        self.trayMoveEnabled = defaults.bool(forKey: Key.trayMoveEnabled)
        self.offerScreenshots = defaults.bool(forKey: Key.offerScreenshots)
        self.trayLastCollectionID = defaults.string(forKey: Key.trayLastCollectionID)
            ?? TrayCollection.shelfID.uuidString
        self.showWeatherWidget = defaults.bool(forKey: Key.showWeatherWidget)
        self.showCalendarWidget = defaults.bool(forKey: Key.showCalendarWidget)
        self.shareMethod = ShareMethod(rawValue: defaults.string(forKey: Key.shareMethod) ?? "airdrop") ?? .airdrop
        self.agentsEnabled = defaults.bool(forKey: Key.agentsEnabled)
        self.agentClaudeEnabled = defaults.bool(forKey: Key.agentClaudeEnabled)
        self.agentCodexEnabled = defaults.bool(forKey: Key.agentCodexEnabled)
        self.agentOpenCodeEnabled = defaults.bool(forKey: Key.agentOpenCodeEnabled)
        self.agentOhMyPiEnabled = defaults.bool(forKey: Key.agentOhMyPiEnabled)
        self.agentT3Enabled = defaults.bool(forKey: Key.agentT3Enabled)
        self.agentT3Environments = defaults.data(forKey: Key.agentT3Environments)
            .flatMap { try? JSONDecoder().decode([T3Environment].self, from: $0) } ?? []
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
        self.pomodoroFocusMinutes = PomodoroPolicy.clampedMinutes(defaults.integer(forKey: Key.pomodoroFocusMinutes))
        self.pomodoroBreakMinutes = PomodoroPolicy.clampedMinutes(defaults.integer(forKey: Key.pomodoroBreakMinutes))
        self.showClockWidget = defaults.bool(forKey: Key.showClockWidget)
        self.clockSecondaryTimeZone = defaults.string(forKey: Key.clockSecondaryTimeZone) ?? ""
        self.showShortcutsWidget = defaults.bool(forKey: Key.showShortcutsWidget)
        self.pinnedShortcuts = defaults.stringArray(forKey: Key.pinnedShortcuts) ?? []
        self.showNoteWidget = defaults.bool(forKey: Key.showNoteWidget)
        self.displayPlacement = DisplayPlacement(
            rawValue: defaults.string(forKey: Key.displayPlacement) ?? "builtIn"
        ) ?? .builtIn
        self.followActiveDisplay = defaults.bool(forKey: Key.followActiveDisplay)
        self.virtualNotchMode = VirtualNotchMode(
            rawValue: defaults.string(forKey: Key.virtualNotchMode) ?? "automatic"
        ) ?? .automatic
        self.displayProfiles = defaults.data(forKey: Key.displayProfiles)
            .flatMap { try? JSONDecoder().decode([DisplayProfile].self, from: $0) } ?? []
    }

    func displayProfile(for displayKey: String) -> DisplayProfile {
        displayProfiles.first(where: { $0.displayKey == displayKey })
            ?? .standard(for: displayKey)
    }

    func updateDisplayProfile(_ profile: DisplayProfile) {
        let profile = profile.normalized
        displayProfiles.removeAll { $0.displayKey == profile.displayKey }
        displayProfiles.append(profile)
    }

    func resetDisplayProfile(for displayKey: String) {
        displayProfiles.removeAll { $0.displayKey == displayKey }
    }
}
