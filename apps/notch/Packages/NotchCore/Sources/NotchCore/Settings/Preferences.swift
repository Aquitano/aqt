import Foundation

/// Every user preference as one versioned document. Groups are plain structs
/// with their defaults in the initializers; adding a preference is one line in
/// its group. Persisted as JSON by `PreferencesStore`, which merges what is on
/// disk over the defaults, so a document written by an older or newer build
/// still decodes.
package struct Preferences: Codable, Equatable {
    package init() {}

    package init(
        general: General,
        notch: Notch,
        display: Display,
        hud: HUD,
        media: Media,
        tray: Tray,
        widgets: Widgets,
        agents: Agents
    ) {
        self.general = general
        self.notch = notch
        self.display = display
        self.hud = hud
        self.media = media
        self.tray = tray
        self.widgets = widgets
        self.agents = agents
    }

    package static let currentVersion = 1

    package var version = currentVersion
    package var general = General()
    package var notch = Notch()
    package var display = Display()
    package var hud = HUD()
    package var media = Media()
    package var tray = Tray()
    package var widgets = Widgets()
    package var agents = Agents()

    package struct General: Codable, Equatable {
        package init() {}
        package var launchAtLogin = false
        package var hapticFeedback = true
        package var hasCompletedOnboarding = false
        package var hotkeyEnabled = false
    }

    package struct Notch: Codable, Equatable {
        package init() {}
        /// Ordered home-tab widgets. Membership means enabled; order is the render
        /// order within each grid row (rows are carved out by `WidgetKind.row`).
        package var widgetLayout = WidgetKind.defaultLayout
        /// Ordered visible tabs. Home is always a member — it is the reset target.
        package var tabLayout = NotchTab.allCases
        /// The tab the panel opens on. Read through `Settings.resolvedDefaultTab`,
        /// which falls back to home when this tab is hidden or its feature is off.
        package var defaultTab = NotchTab.home
        package var tabBarStyle = TabBarStyle.floating
    }

    package struct Display: Codable, Equatable {
        package init() {}
        package var placement = DisplayPlacement.builtIn
        package var followActive = false
        package var virtualNotchMode = VirtualNotchMode.automatic
        package var profiles: [DisplayProfile] = []
    }

    package struct HUD: Codable, Equatable {
        package init() {}
        package var enabled = true
        /// Consume media keys and suppress the native HUD (needs Accessibility).
        package var replacesSystem = false
    }

    package struct Media: Codable, Equatable {
        package init() {}
        package var systemWideAdapter = true
        package var compactNowPlaying = true
        /// Capturing real system-audio levels requires an explicit privacy grant.
        /// Opt-in so an update never surprises the user with a prompt.
        package var audioVisualizer = false
    }

    package struct Tray: Codable, Equatable {
        package init() {}
        package var ttlDays = 7
        package var moveEnabled = false
        package var offerScreenshots = false
        package var lastCollectionID = TrayCollection.shelfID.uuidString
        package var shareMethod = ShareMethod.airdrop
    }

    package struct Widgets: Codable, Equatable {
        package init() {}
        package var temperatureUnit = WeatherSnapshot.TemperatureUnit.celsius
        /// Battery percentage that fires the low-battery alert; re-arms 5 above it.
        package var lowBatteryThreshold = 20
        package var pomodoroFocusMinutes = PomodoroPolicy.defaultMinutes(for: .focus)
        package var pomodoroBreakMinutes = PomodoroPolicy.defaultMinutes(for: .rest)
        /// Time-zone identifier for the clock tile's second line; empty = none.
        package var clockSecondaryTimeZone = ""
        package var pinnedShortcuts: [String] = []
    }

    package struct Agents: Codable, Equatable {
        package init() {}
        package var enabled = true
        package var claudeEnabled = false
        package var codexEnabled = false
        package var openCodeEnabled = false
        package var ohMyPiEnabled = false
        package var t3Enabled = false
        /// Paired t3 servers (label + base URL); each pairing's bearer token lives
        /// in the Keychain under the environment's `tokenAccount`.
        package var t3Environments: [T3Environment] = []
        package var notifyStarted = false
        package var notifyAttention = true
        package var notifyFinished = true
        package var autoExpandOnAttention = false
        package var systemNotifications = false
        /// Skip the peek, sound and banner while the session's own terminal is the
        /// frontmost window — you are already looking at what they would announce.
        package var quietWhenFocused = true
        package var soundEnabled = false
        package var soundStarted = AgentSound.boot.rawValue
        package var soundAttention = AgentSound.alert.rawValue
        package var soundFinished = AgentSound.complete.rawValue
        package var usageLimits = false
        package var permissionApproval = false
    }
}

extension Preferences {
    /// Decodes a document over the defaults: keys missing on disk keep their
    /// default, unknown keys are ignored, and a `version` older than the current
    /// one runs the migrations in order first.
    package static func decode(_ data: Data) throws -> Preferences {
        guard var stored = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: [],
                debugDescription: "preferences root is not an object"
            ))
        }
        let version = stored["version"] as? Int ?? 0
        if version < currentVersion {
            stored = migrate(stored, from: version)
        }
        let defaults = try JSONSerialization
            .jsonObject(with: JSONEncoder().encode(Preferences())) as? [String: Any] ?? [:]
        let merged = try JSONSerialization.data(withJSONObject: deepMerge(base: defaults, overlay: stored))
        var preferences = try JSONDecoder().decode(Preferences.self, from: merged)
        preferences.version = currentVersion
        return preferences.normalized
    }

    private static func migrate(_ document: [String: Any], from _: Int) -> [String: Any] {
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
    package var normalized: Preferences {
        var copy = self
        if !copy.notch.tabLayout.contains(.home) {
            copy.notch.tabLayout.insert(.home, at: 0)
        }
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
    package static func importingLegacyDefaults(_ defaults: UserDefaults) -> Preferences {
        var p = Preferences()
        func bool(_ key: String, _ target: inout Bool) {
            if let value = defaults.object(forKey: key) as? Bool {
                target = value
            }
        }
        func int(_ key: String, _ target: inout Int) {
            if let value = defaults.object(forKey: key) as? Int {
                target = value
            }
        }
        func string(_ key: String, _ target: inout String) {
            if let value = defaults.string(forKey: key) {
                target = value
            }
        }
        func raw<T: RawRepresentable>(_ key: String, _ target: inout T) where T.RawValue == String {
            if let value = defaults.string(forKey: key).flatMap(T.init(rawValue:)) {
                target = value
            }
        }
        func json<T: Decodable>(_ key: String, _ target: inout T) {
            if let value = defaults.data(forKey: key).flatMap({ try? JSONDecoder().decode(T.self, from: $0) }) {
                target = value
            }
        }

        bool("hapticFeedback", &p.general.hapticFeedback)
        bool("hasCompletedOnboarding", &p.general.hasCompletedOnboarding)
        bool("hotkeyEnabled", &p.general.hotkeyEnabled)

        if let stored = defaults.stringArray(forKey: "widgetLayout") {
            p.notch.widgetLayout = stored.compactMap(WidgetKind.init(rawValue:))
        } else {
            p.notch.widgetLayout = legacyWidgetLayout(defaults)
        }
        if let stored = defaults.stringArray(forKey: "tabLayout") {
            p.notch.tabLayout = stored.compactMap(NotchTab.init(rawValue:))
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
        if let pinned = defaults.stringArray(forKey: "pinnedShortcuts") {
            p.widgets.pinnedShortcuts = pinned
        }

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
        if flag("showClockWidget", default: false) {
            layout.append(.clock)
        }
        layout += [.focus, .bluetooth]
        if flag("showWeatherWidget", default: true) {
            layout.append(.weather)
        }
        if flag("showCalendarWidget", default: true) {
            layout.append(.calendar)
        }
        if flag("showShortcutsWidget", default: false) {
            layout.append(.shortcuts)
        }
        if flag("showNoteWidget", default: false) {
            layout.append(.note)
        }
        return layout
    }
}

/// The toggle-notch chord, a Carbon key code and modifier mask, that preference
/// documents from before KeyboardShortcuts store under `general`.
package struct LegacyHotkey {
    package let keyCode: Int
    package let modifiers: Int

    package init?(document data: Data) {
        guard let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let general = document["general"] as? [String: Any],
              let keyCode = general["hotkeyKeyCode"] as? Int,
              let modifiers = general["hotkeyModifiers"] as? Int
        else { return nil }
        self.keyCode = keyCode
        self.modifiers = modifiers
    }
}

/// Reads and writes the preferences document. Kept apart from `Settings` so the
/// document format is testable without the observable object.
package struct PreferencesStore {
    package static let fileName = "preferences.json"

    package let persistence: Persistence
    package let legacyDefaults: UserDefaults?
    package let diagnostics: Diagnostics?

    package init(persistence: Persistence, legacyDefaults: UserDefaults? = .standard, diagnostics: Diagnostics? = nil) {
        self.persistence = persistence
        self.legacyDefaults = legacyDefaults
        self.diagnostics = diagnostics
    }

    /// The stored document, the legacy import when there is none yet, or the
    /// defaults when the document is unreadable (the broken file is kept aside).
    package func load() -> Preferences {
        let data: Data?
        do {
            data = try persistence.loadData(from: Self.fileName)
        } catch {
            diagnostics?.report(source: "Preferences", error)
            return Preferences()
        }
        guard let data else {
            let imported = legacyDefaults.map(Preferences.importingLegacyDefaults) ?? Preferences()
            do {
                try persistence.saveSynchronously(imported, to: Self.fileName)
            } catch {
                diagnostics?.report(source: "Preferences", error)
            }
            return imported
        }
        do {
            return try Preferences.decode(data)
        } catch {
            diagnostics?.report(
                source: "Preferences",
                message: "preferences.json is unreadable; using defaults and keeping the file as preferences.json.broken (\(error.localizedDescription))"
            )
            try? persistence.writeBackupIfMissing(data, to: Self.fileName + ".broken")
            return Preferences()
        }
    }

    package func save(_ preferences: Preferences) {
        persistence.save(preferences, to: Self.fileName)
    }

    /// Saving any document drops the chord, since `General` no longer has it.
    package func legacyHotkey() -> LegacyHotkey? {
        // load() has already reported a file that cannot be read.
        guard let data = try? persistence.loadData(from: Self.fileName) else { return nil }
        return LegacyHotkey(document: data)
    }
}
