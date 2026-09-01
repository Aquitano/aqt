import Foundation

/// Every user preference as one versioned document. Groups are plain structs
/// with their defaults in the initializers; adding a preference is one line in
/// its group. Persisted as JSON by `PreferencesStore`, which merges what is on
/// disk over the defaults, so a document written by an older or newer build
/// still decodes.
struct Preferences: Codable, Equatable {
    static let currentVersion = 1

    var version = currentVersion
    var general = General()
    var notch = Notch()
    var display = Display()
    var hud = HUD()
    var media = Media()
    var tray = Tray()
    var widgets = Widgets()
    var agents = Agents()

    struct General: Codable, Equatable {
        var launchAtLogin = false
        var hapticFeedback = true
        var hasCompletedOnboarding = false
        var hotkeyEnabled = false
        /// Carbon virtual key code + modifier mask for the toggle-notch hotkey.
        var hotkeyKeyCode = 45       // kVK_ANSI_N
        var hotkeyModifiers = 6144   // controlKey | optionKey
    }

    struct Notch: Codable, Equatable {
        /// Ordered home-tab widgets. Membership means enabled; order is the render
        /// order within each grid row (rows are carved out by `WidgetKind.row`).
        var widgetLayout = WidgetKind.defaultLayout
        /// Ordered visible tabs. Home is always a member — it is the reset target.
        var tabLayout = NotchState.ExpandedTab.allCases
        /// The tab the panel opens on. Read through `Settings.resolvedDefaultTab`,
        /// which falls back to home when this tab is hidden or its feature is off.
        var defaultTab = NotchState.ExpandedTab.home
        var tabBarStyle = TabBarStyle.floating
    }

    struct Display: Codable, Equatable {
        var placement = DisplayPlacement.builtIn
        var followActive = false
        var virtualNotchMode = VirtualNotchMode.automatic
        var profiles: [DisplayProfile] = []
    }

    struct HUD: Codable, Equatable {
        var enabled = true
        /// Consume media keys and suppress the native HUD (needs Accessibility).
        var replacesSystem = false
    }

    struct Media: Codable, Equatable {
        var systemWideAdapter = true
        var compactNowPlaying = true
        /// Capturing real system-audio levels requires an explicit privacy grant.
        /// Opt-in so an update never surprises the user with a prompt.
        var audioVisualizer = false
    }

    struct Tray: Codable, Equatable {
        var ttlDays = 7
        var moveEnabled = false
        var offerScreenshots = false
        var lastCollectionID = TrayCollection.shelfID.uuidString
        var shareMethod = ShareMethod.airdrop
    }

    struct Widgets: Codable, Equatable {
        var temperatureUnit = WeatherSnapshot.TemperatureUnit.celsius
        /// Battery percentage that fires the low-battery alert; re-arms 5 above it.
        var lowBatteryThreshold = 20
        var pomodoroFocusMinutes = PomodoroPolicy.defaultMinutes(for: .focus)
        var pomodoroBreakMinutes = PomodoroPolicy.defaultMinutes(for: .rest)
        /// Time-zone identifier for the clock tile's second line; empty = none.
        var clockSecondaryTimeZone = ""
        var pinnedShortcuts: [String] = []
    }

    struct Agents: Codable, Equatable {
        var enabled = true
        var claudeEnabled = false
        var codexEnabled = false
        var openCodeEnabled = false
        var ohMyPiEnabled = false
        var t3Enabled = false
        /// Paired t3 servers (label + base URL); each pairing's bearer token lives
        /// in the Keychain under the environment's `tokenAccount`.
        var t3Environments: [T3Environment] = []
        var notifyStarted = false
        var notifyAttention = true
        var notifyFinished = true
        var autoExpandOnAttention = false
        var systemNotifications = false
        /// Skip the peek, sound and banner while the session's own terminal is the
        /// frontmost window — you are already looking at what they would announce.
        var quietWhenFocused = true
        var soundEnabled = false
        var soundStarted = AgentSound.boot.rawValue
        var soundAttention = AgentSound.alert.rawValue
        var soundFinished = AgentSound.complete.rawValue
        var usageLimits = false
        var permissionApproval = false
    }
}

extension Preferences {
    /// Decodes a document over the defaults: keys missing on disk keep their
    /// default, unknown keys are ignored, and a `version` older than the current
    /// one runs the migrations in order first.
    static func decode(_ data: Data) throws -> Preferences {
        guard var stored = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "preferences root is not an object"))
        }
        let version = stored["version"] as? Int ?? 0
        if version < currentVersion { stored = migrate(stored, from: version) }
        let defaults = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Preferences())) as? [String: Any] ?? [:]
        let merged = try JSONSerialization.data(withJSONObject: deepMerge(base: defaults, overlay: stored))
        var preferences = try JSONDecoder().decode(Preferences.self, from: merged)
        preferences.version = currentVersion
        return preferences.normalized
    }

    private static func migrate(_ document: [String: Any], from version: Int) -> [String: Any] {
        // Version 1 is the first document format; future migrations rewrite the
        // dictionary here, one `if version < N` block per step.
        document
    }

    private static func deepMerge(base: [String: Any], overlay: [String: Any]) -> [String: Any] {
        var result = base
        for (key, value) in overlay {
            if let nested = value as? [String: Any], let existing = result[key] as? [String: Any] {
                result[key] = deepMerge(base: existing, overlay: nested)
            } else {
                result[key] = value
            }
        }
        return result
    }

    /// Repairs values that decode fine but are out of range or structurally
    /// invalid, so the rest of the app never has to defend against them.
    var normalized: Preferences {
        var copy = self
        if !copy.notch.tabLayout.contains(.home) { copy.notch.tabLayout.insert(.home, at: 0) }
        copy.widgets.pomodoroFocusMinutes = PomodoroPolicy.clampedMinutes(copy.widgets.pomodoroFocusMinutes)
        copy.widgets.pomodoroBreakMinutes = PomodoroPolicy.clampedMinutes(copy.widgets.pomodoroBreakMinutes)
        copy.agents.soundStarted = AgentSound.normalizedName(copy.agents.soundStarted, fallback: .boot)
        copy.agents.soundAttention = AgentSound.normalizedName(copy.agents.soundAttention, fallback: .alert)
        copy.agents.soundFinished = AgentSound.normalizedName(copy.agents.soundFinished, fallback: .complete)
        return copy
    }
}

extension Preferences {
    /// One-time import of the pre-document preferences, which lived as individual
    /// UserDefaults keys. Runs only when no `preferences.json` exists yet; the old
    /// keys are left in place so an older build still starts.
    static func importingLegacyDefaults(_ defaults: UserDefaults) -> Preferences {
        var p = Preferences()
        func bool(_ key: String, _ target: inout Bool) {
            if let value = defaults.object(forKey: key) as? Bool { target = value }
        }
        func int(_ key: String, _ target: inout Int) {
            if let value = defaults.object(forKey: key) as? Int { target = value }
        }
        func string(_ key: String, _ target: inout String) {
            if let value = defaults.string(forKey: key) { target = value }
        }
        func raw<T: RawRepresentable>(_ key: String, _ target: inout T) where T.RawValue == String {
            if let value = defaults.string(forKey: key).flatMap(T.init(rawValue:)) { target = value }
        }
        func json<T: Decodable>(_ key: String, _ target: inout T) {
            if let value = defaults.data(forKey: key).flatMap({ try? JSONDecoder().decode(T.self, from: $0) }) {
                target = value
            }
        }

        bool("hapticFeedback", &p.general.hapticFeedback)
        bool("hasCompletedOnboarding", &p.general.hasCompletedOnboarding)
        bool("hotkeyEnabled", &p.general.hotkeyEnabled)
        int("hotkeyKeyCode", &p.general.hotkeyKeyCode)
        int("hotkeyModifiers", &p.general.hotkeyModifiers)

        if let stored = defaults.stringArray(forKey: "widgetLayout") {
            p.notch.widgetLayout = stored.compactMap(WidgetKind.init(rawValue:))
        } else {
            p.notch.widgetLayout = legacyWidgetLayout(defaults)
        }
        if let stored = defaults.stringArray(forKey: "tabLayout") {
            p.notch.tabLayout = stored.compactMap(NotchState.ExpandedTab.init(rawValue:))
        }
        raw("defaultExpandedTab", &p.notch.defaultTab)
        if let style = defaults.string(forKey: "tabBarStyle").flatMap(TabBarStyle.init(rawValue:)) {
            p.notch.tabBarStyle = style
        } else if let floating = defaults.object(forKey: "floatingTabBar") as? Bool {
            p.notch.tabBarStyle = floating ? .floating : .inside
        }

        raw("displayPlacement", &p.display.placement)
        bool("followActiveDisplay", &p.display.followActive)
        raw("virtualNotchMode", &p.display.virtualNotchMode)
        json("displayProfiles", &p.display.profiles)

        bool("showHUD", &p.hud.enabled)
        bool("hudReplacesSystem", &p.hud.replacesSystem)

        bool("enableMediaAdapter", &p.media.systemWideAdapter)
        bool("showCompactNowPlaying", &p.media.compactNowPlaying)
        bool("showAudioVisualizer", &p.media.audioVisualizer)

        int("trayTTLDays", &p.tray.ttlDays)
        bool("trayMoveEnabled", &p.tray.moveEnabled)
        bool("offerScreenshots", &p.tray.offerScreenshots)
        string("trayLastCollectionID", &p.tray.lastCollectionID)
        raw("shareMethod", &p.tray.shareMethod)

        raw("temperatureUnit", &p.widgets.temperatureUnit)
        int("lowBatteryThreshold", &p.widgets.lowBatteryThreshold)
        int("pomodoroFocusMinutes", &p.widgets.pomodoroFocusMinutes)
        int("pomodoroBreakMinutes", &p.widgets.pomodoroBreakMinutes)
        string("clockSecondaryTimeZone", &p.widgets.clockSecondaryTimeZone)
        if let pinned = defaults.stringArray(forKey: "pinnedShortcuts") { p.widgets.pinnedShortcuts = pinned }

        bool("agentsEnabled", &p.agents.enabled)
        bool("agentClaudeEnabled", &p.agents.claudeEnabled)
        bool("agentCodexEnabled", &p.agents.codexEnabled)
        bool("agentOpenCodeEnabled", &p.agents.openCodeEnabled)
        bool("agentOhMyPiEnabled", &p.agents.ohMyPiEnabled)
        bool("agentT3Enabled", &p.agents.t3Enabled)
        json("agentT3Environments", &p.agents.t3Environments)
        bool("agentNotifyStarted", &p.agents.notifyStarted)
        bool("agentNotifyAttention", &p.agents.notifyAttention)
        bool("agentNotifyFinished", &p.agents.notifyFinished)
        bool("agentAutoExpandOnAttention", &p.agents.autoExpandOnAttention)
        bool("agentSystemNotifications", &p.agents.systemNotifications)
        bool("agentQuietWhenFocused", &p.agents.quietWhenFocused)
        bool("agentNotifySound", &p.agents.soundEnabled)
        string("agentSoundStarted", &p.agents.soundStarted)
        string("agentSoundAttention", &p.agents.soundAttention)
        string("agentSoundFinished", &p.agents.soundFinished)
        bool("agentUsageLimits", &p.agents.usageLimits)
        bool("agentPermissionApproval", &p.agents.permissionApproval)
        return p.normalized
    }

    /// The pre-layout per-widget booleans, mapped to the ordered layout.
    private static func legacyWidgetLayout(_ defaults: UserDefaults) -> [WidgetKind] {
        func flag(_ key: String, default fallback: Bool) -> Bool {
            defaults.object(forKey: key) as? Bool ?? fallback
        }
        var layout: [WidgetKind] = [.battery]
        if flag("showClockWidget", default: false) { layout.append(.clock) }
        layout += [.focus, .bluetooth]
        if flag("showWeatherWidget", default: true) { layout.append(.weather) }
        if flag("showCalendarWidget", default: true) { layout.append(.calendar) }
        if flag("showShortcutsWidget", default: false) { layout.append(.shortcuts) }
        if flag("showNoteWidget", default: false) { layout.append(.note) }
        return layout
    }
}

/// Reads and writes the preferences document. Kept apart from `Settings` so the
/// document format is testable without the observable object.
struct PreferencesStore {
    static let fileName = "preferences.json"

    let persistence: Persistence
    let legacyDefaults: UserDefaults?

    init(persistence: Persistence, legacyDefaults: UserDefaults? = .standard) {
        self.persistence = persistence
        self.legacyDefaults = legacyDefaults
    }

    /// The stored document, the legacy import when there is none yet, or the
    /// defaults when the document is unreadable (the broken file is kept aside).
    func load() -> Preferences {
        guard let data = persistence.loadData(from: Self.fileName) else {
            let imported = legacyDefaults.map(Preferences.importingLegacyDefaults) ?? Preferences()
            _ = persistence.saveSynchronously(imported, to: Self.fileName)
            return imported
        }
        do {
            return try Preferences.decode(data)
        } catch {
            Log.app.error("preferences.json unreadable, keeping it as .broken and using defaults: \(String(describing: error))")
            _ = persistence.writeBackupIfMissing(data, to: Self.fileName + ".broken")
            return Preferences()
        }
    }

    func save(_ preferences: Preferences) {
        persistence.save(preferences, to: Self.fileName)
    }
}
