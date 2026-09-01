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
        static let widgetLayout = "widgetLayout"
        static let tabLayout = "tabLayout"
        static let defaultExpandedTab = "defaultExpandedTab"
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
        static let agentQuietWhenFocused = "agentQuietWhenFocused"
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
        static let tabBarStyle = "tabBarStyle"
        /// Superseded by `tabBarStyle`; still read once to migrate.
        static let floatingTabBar = "floatingTabBar"
        static let lowBatteryThreshold = "lowBatteryThreshold"
        static let pomodoroFocusMinutes = "pomodoroFocusMinutes"
        static let pomodoroBreakMinutes = "pomodoroBreakMinutes"
        static let clockSecondaryTimeZone = "clockSecondaryTimeZone"
        static let pinnedShortcuts = "pinnedShortcuts"
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
    /// Ordered home-tab widgets. Membership means enabled; order is the render
    /// order within each grid row (rows are carved out by `WidgetKind.row`).
    @Published var widgetLayout: [WidgetKind] {
        didSet { defaults.set(widgetLayout.map(\.rawValue), forKey: Key.widgetLayout) }
    }
    /// Ordered visible tabs in the expanded panel. Home is always a member — it
    /// is the reset target the panel falls back to.
    @Published var tabLayout: [NotchState.ExpandedTab] {
        didSet { defaults.set(tabLayout.map(\.rawValue), forKey: Key.tabLayout) }
    }
    /// The tab the panel opens on. Read through `resolvedDefaultTab`, which
    /// falls back to home when this tab is hidden or its feature is off.
    @Published var defaultExpandedTab: NotchState.ExpandedTab {
        didSet { defaults.set(defaultExpandedTab.rawValue, forKey: Key.defaultExpandedTab) }
    }
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
    /// Skip the peek, sound and banner while the session's own terminal is the
    /// frontmost window — you are already looking at what they would announce.
    @Published var agentQuietWhenFocused: Bool { didSet { defaults.set(agentQuietWhenFocused, forKey: Key.agentQuietWhenFocused) } }
    @Published var agentNotifySound: Bool { didSet { defaults.set(agentNotifySound, forKey: Key.agentNotifySound) } }
    @Published var agentSoundStarted: String { didSet { defaults.set(agentSoundStarted, forKey: Key.agentSoundStarted) } }
    @Published var agentSoundAttention: String { didSet { defaults.set(agentSoundAttention, forKey: Key.agentSoundAttention) } }
    @Published var agentSoundFinished: String { didSet { defaults.set(agentSoundFinished, forKey: Key.agentSoundFinished) } }
    @Published var agentUsageLimits: Bool { didSet { defaults.set(agentUsageLimits, forKey: Key.agentUsageLimits) } }
    @Published var agentPermissionApproval: Bool { didSet { defaults.set(agentPermissionApproval, forKey: Key.agentPermissionApproval) } }
    @Published var hasCompletedOnboarding: Bool { didSet { defaults.set(hasCompletedOnboarding, forKey: Key.hasCompletedOnboarding) } }
    @Published var hotkeyEnabled: Bool { didSet { defaults.set(hotkeyEnabled, forKey: Key.hotkeyEnabled) } }
    /// Carbon virtual key code + modifier mask for the toggle-notch hotkey,
    /// recorded via the Settings shortcut control.
    @Published var hotkeyKeyCode: Int { didSet { defaults.set(hotkeyKeyCode, forKey: Key.hotkeyKeyCode) } }
    @Published var hotkeyModifiers: Int { didSet { defaults.set(hotkeyModifiers, forKey: Key.hotkeyModifiers) } }
    /// True while the Settings recorder is capturing a chord. Not persisted;
    /// the AppDelegate suspends the live registration so the current chord can
    /// be re-typed without toggling the notch.
    @Published var isRecordingHotkey = false
    /// Where the expanded panel's section switcher renders: its own capsule below
    /// the blob, a strip inside it, or straight on the notch shoulders.
    @Published var tabBarStyle: TabBarStyle { didSet { defaults.set(tabBarStyle.rawValue, forKey: Key.tabBarStyle) } }
    /// Battery percentage that fires the low-battery alert; re-arms 5 above it.
    @Published var lowBatteryThreshold: Int { didSet { defaults.set(lowBatteryThreshold, forKey: Key.lowBatteryThreshold) } }
    /// Last dial position per pomodoro phase, so the timer tab reopens on the
    /// durations the user actually uses.
    @Published var pomodoroFocusMinutes: Int { didSet { defaults.set(pomodoroFocusMinutes, forKey: Key.pomodoroFocusMinutes) } }
    @Published var pomodoroBreakMinutes: Int { didSet { defaults.set(pomodoroBreakMinutes, forKey: Key.pomodoroBreakMinutes) } }
    /// Time-zone identifier for the clock tile's second line; empty = none.
    @Published var clockSecondaryTimeZone: String { didSet { defaults.set(clockSecondaryTimeZone, forKey: Key.clockSecondaryTimeZone) } }
    @Published var pinnedShortcuts: [String] { didSet { defaults.set(pinnedShortcuts, forKey: Key.pinnedShortcuts) } }
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
        widgetLayout.contains { $0.row == .info }
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
            Key.agentQuietWhenFocused: true,
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
            Key.lowBatteryThreshold: 20,
            Key.pomodoroFocusMinutes: PomodoroPolicy.defaultMinutes(for: .focus),
            Key.pomodoroBreakMinutes: PomodoroPolicy.defaultMinutes(for: .rest),
            Key.clockSecondaryTimeZone: "",
            Key.pinnedShortcuts: [String](),
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
        self.widgetLayout = Self.loadWidgetLayout(from: defaults)
        self.tabLayout = Self.loadTabLayout(from: defaults)
        self.defaultExpandedTab = NotchState.ExpandedTab(
            rawValue: defaults.string(forKey: Key.defaultExpandedTab) ?? "home"
        ) ?? .home
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
        self.agentQuietWhenFocused = defaults.bool(forKey: Key.agentQuietWhenFocused)
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
        self.tabBarStyle = Self.loadTabBarStyle(from: defaults)
        self.lowBatteryThreshold = defaults.integer(forKey: Key.lowBatteryThreshold)
        self.pomodoroFocusMinutes = PomodoroPolicy.clampedMinutes(defaults.integer(forKey: Key.pomodoroFocusMinutes))
        self.pomodoroBreakMinutes = PomodoroPolicy.clampedMinutes(defaults.integer(forKey: Key.pomodoroBreakMinutes))
        self.clockSecondaryTimeZone = defaults.string(forKey: Key.clockSecondaryTimeZone) ?? ""
        self.pinnedShortcuts = defaults.stringArray(forKey: Key.pinnedShortcuts) ?? []
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

    /// Reads the stored layout, migrating from the pre-layout per-widget booleans
    /// on first run so an existing setup keeps its exact widget set.
    private static func loadWidgetLayout(from defaults: UserDefaults) -> [WidgetKind] {
        if let stored = defaults.stringArray(forKey: Key.widgetLayout) {
            return stored.compactMap(WidgetKind.init(rawValue:))
        }
        func legacy(_ key: String, default fallback: Bool) -> Bool {
            defaults.object(forKey: key) as? Bool ?? fallback
        }
        var layout: [WidgetKind] = [.battery]
        if legacy("showClockWidget", default: false) { layout.append(.clock) }
        layout += [.focus, .bluetooth]
        if legacy("showWeatherWidget", default: true) { layout.append(.weather) }
        if legacy("showCalendarWidget", default: true) { layout.append(.calendar) }
        if legacy("showShortcutsWidget", default: false) { layout.append(.shortcuts) }
        if legacy("showNoteWidget", default: false) { layout.append(.note) }
        return layout
    }

    /// Reads the stored style, migrating from the pre-shoulders `floatingTabBar`
    /// boolean on first run so an existing setup keeps its placement. Floating is
    /// the fallback because that was the boolean's registered default.
    private static func loadTabBarStyle(from defaults: UserDefaults) -> TabBarStyle {
        if let stored = defaults.string(forKey: Key.tabBarStyle),
           let style = TabBarStyle(rawValue: stored) {
            return style
        }
        return (defaults.object(forKey: Key.floatingTabBar) as? Bool ?? true) ? .floating : .inside
    }

    private static func loadTabLayout(from defaults: UserDefaults) -> [NotchState.ExpandedTab] {
        var layout = defaults.stringArray(forKey: Key.tabLayout)?
            .compactMap(NotchState.ExpandedTab.init(rawValue:))
            ?? NotchState.ExpandedTab.allCases
        if !layout.contains(.home) { layout.insert(.home, at: 0) }
        return layout
    }

    /// The tab the panel actually opens on: the configured default, unless it is
    /// hidden or the agents feature backing it is off.
    var resolvedDefaultTab: NotchState.ExpandedTab {
        let tab = defaultExpandedTab
        guard tabLayout.contains(tab), tab != .agents || agentsEnabled else { return .home }
        return tab
    }

    func isTabVisible(_ tab: NotchState.ExpandedTab) -> Bool {
        tabLayout.contains(tab)
    }

    func setTab(_ tab: NotchState.ExpandedTab, visible: Bool) {
        guard tab != .home else { return }
        if visible {
            guard !tabLayout.contains(tab) else { return }
            tabLayout.append(tab)
        } else {
            tabLayout.removeAll { $0 == tab }
            if defaultExpandedTab == tab { defaultExpandedTab = .home }
        }
    }

    func isWidgetEnabled(_ kind: WidgetKind) -> Bool {
        widgetLayout.contains(kind)
    }

    func setWidget(_ kind: WidgetKind, enabled: Bool) {
        widgetLayout = Self.applying(kind, enabled: enabled, to: widgetLayout)
    }

    /// Shifts a widget by whole slots within its own row, leaving the other
    /// row's ordering untouched.
    func moveWidget(_ kind: WidgetKind, by slots: Int) {
        widgetLayout = Self.moving(kind, by: slots, in: widgetLayout)
    }

    private static func applying(_ kind: WidgetKind, enabled: Bool, to layout: [WidgetKind]) -> [WidgetKind] {
        var layout = layout
        if enabled {
            if !layout.contains(kind) { layout.append(kind) }
        } else {
            layout.removeAll { $0 == kind }
        }
        return layout
    }

    private static func moving(_ kind: WidgetKind, by slots: Int, in layout: [WidgetKind]) -> [WidgetKind] {
        var row = layout.filter { $0.row == kind.row }
        guard let index = row.firstIndex(of: kind), slots != 0 else { return layout }
        let target = max(0, min(row.count - 1, index + slots))
        row.remove(at: index)
        row.insert(kind, at: target)
        let other = layout.filter { $0.row != kind.row }
        return kind.row == .status ? row + other : other + row
    }

    // MARK: - Per-display overrides

    /// The widget layout a given display renders: its override when one exists,
    /// otherwise the global layout. An unknown/empty key resolves globally.
    func widgetLayout(for displayKey: String) -> [WidgetKind] {
        overrideWidgetLayout(for: displayKey) ?? widgetLayout
    }

    func hasInfoRowWidgets(for displayKey: String) -> Bool {
        widgetLayout(for: displayKey).contains { $0.row == .info }
    }

    func hasCustomWidgetLayout(for displayKey: String) -> Bool {
        displayProfiles.first { $0.displayKey == displayKey }?.widgetLayout != nil
    }

    /// Fork the current global layout into a display override, or drop the
    /// override so the display follows the global layout again.
    func setCustomWidgetLayout(_ custom: Bool, for displayKey: String) {
        var profile = displayProfile(for: displayKey)
        profile.widgetLayout = custom ? widgetLayout.map(\.rawValue) : nil
        updateDisplayProfile(profile)
    }

    func setWidget(_ kind: WidgetKind, enabled: Bool, on displayKey: String) {
        if let override = overrideWidgetLayout(for: displayKey) {
            storeWidgetOverride(Self.applying(kind, enabled: enabled, to: override), for: displayKey)
        } else {
            setWidget(kind, enabled: enabled)
        }
    }

    func moveWidget(_ kind: WidgetKind, by slots: Int, on displayKey: String) {
        if let override = overrideWidgetLayout(for: displayKey) {
            storeWidgetOverride(Self.moving(kind, by: slots, in: override), for: displayKey)
        } else {
            moveWidget(kind, by: slots)
        }
    }

    /// The tab a given display's panel opens on: its override when set and
    /// still visible, otherwise the global resolution.
    func resolvedDefaultTab(for displayKey: String) -> NotchState.ExpandedTab {
        guard let raw = displayProfiles.first(where: { $0.displayKey == displayKey })?.defaultTab,
              let tab = NotchState.ExpandedTab(rawValue: raw),
              tabLayout.contains(tab), tab != .agents || agentsEnabled
        else { return resolvedDefaultTab }
        return tab
    }

    private func overrideWidgetLayout(for displayKey: String) -> [WidgetKind]? {
        displayProfiles.first { $0.displayKey == displayKey }?.widgetLayout?
            .compactMap(WidgetKind.init(rawValue:))
    }

    private func storeWidgetOverride(_ layout: [WidgetKind], for displayKey: String) {
        var profile = displayProfile(for: displayKey)
        profile.widgetLayout = layout.map(\.rawValue)
        updateDisplayProfile(profile)
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

    /// Resets a display's geometry adjustments while keeping its widget/tab
    /// overrides (the Settings button only promises size and position).
    func resetDisplayProfile(for displayKey: String) {
        guard let existing = displayProfiles.first(where: { $0.displayKey == displayKey }) else { return }
        var profile = DisplayProfile.standard(for: displayKey)
        profile.widgetLayout = existing.widgetLayout
        profile.defaultTab = existing.defaultTab
        if profile == .standard(for: displayKey) {
            displayProfiles.removeAll { $0.displayKey == displayKey }
        } else {
            updateDisplayProfile(profile)
        }
    }
}
