import Foundation

/// App preferences persisted as one versioned JSON document. Login-item state
/// belongs to macOS; KeyboardShortcuts stores its key binding in UserDefaults.
/// Groups carry their defaults in their initializers. `PreferencesStore` merges
/// saved values over those defaults so older and newer documents still decode.
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
        let legacy = LegacyDefaults(defaults: defaults)

        legacy.bool("hapticFeedback", &p.general.hapticFeedback)
        legacy.bool("hasCompletedOnboarding", &p.general.hasCompletedOnboarding)
        legacy.bool("hotkeyEnabled", &p.general.hotkeyEnabled)

        if let stored = defaults.stringArray(forKey: "widgetLayout") {
            p.notch.widgetLayout = stored.compactMap(WidgetKind.init(rawValue:))
        } else {
            p.notch.widgetLayout = legacyWidgetLayout(defaults)
        }
        if let stored = defaults.stringArray(forKey: "tabLayout") {
            p.notch.tabLayout = stored.compactMap(NotchTab.init(rawValue:))
        }
        legacy.raw("defaultExpandedTab", &p.notch.defaultTab)
        if let style = defaults.string(forKey: "tabBarStyle").flatMap(TabBarStyle.init(rawValue:)) {
            p.notch.tabBarStyle = style
        } else if let floating = defaults.object(forKey: "floatingTabBar") as? Bool {
            p.notch.tabBarStyle = floating ? .floating : .inside
        }

        legacy.raw("displayPlacement", &p.display.placement)
        legacy.bool("followActiveDisplay", &p.display.followActive)
        legacy.raw("virtualNotchMode", &p.display.virtualNotchMode)
        legacy.json("displayProfiles", &p.display.profiles)

        legacy.bool("showHUD", &p.hud.enabled)
        legacy.bool("hudReplacesSystem", &p.hud.replacesSystem)

        legacy.bool("enableMediaAdapter", &p.media.systemWideAdapter)
        legacy.bool("showCompactNowPlaying", &p.media.compactNowPlaying)
        legacy.bool("showAudioVisualizer", &p.media.audioVisualizer)

        legacy.int("trayTTLDays", &p.tray.ttlDays)
        legacy.bool("trayMoveEnabled", &p.tray.moveEnabled)
        legacy.bool("offerScreenshots", &p.tray.offerScreenshots)
        legacy.string("trayLastCollectionID", &p.tray.lastCollectionID)
        legacy.raw("shareMethod", &p.tray.shareMethod)

        legacy.raw("temperatureUnit", &p.widgets.temperatureUnit)
        legacy.int("lowBatteryThreshold", &p.widgets.lowBatteryThreshold)
        legacy.int("pomodoroFocusMinutes", &p.widgets.pomodoroFocusMinutes)
        legacy.int("pomodoroBreakMinutes", &p.widgets.pomodoroBreakMinutes)
        legacy.string("clockSecondaryTimeZone", &p.widgets.clockSecondaryTimeZone)
        if let pinned = defaults.stringArray(forKey: "pinnedShortcuts") {
            p.widgets.pinnedShortcuts = pinned
        }

        importLegacyAgents(legacy, into: &p.agents)
        return p.normalized
    }

    private static func importLegacyAgents(_ legacy: LegacyDefaults, into agents: inout Agents) {
        legacy.bool("agentsEnabled", &agents.enabled)
        legacy.bool("agentClaudeEnabled", &agents.claudeEnabled)
        legacy.bool("agentCodexEnabled", &agents.codexEnabled)
        legacy.bool("agentOpenCodeEnabled", &agents.openCodeEnabled)
        legacy.bool("agentOhMyPiEnabled", &agents.ohMyPiEnabled)
        legacy.bool("agentT3Enabled", &agents.t3Enabled)
        legacy.json("agentT3Environments", &agents.t3Environments)
        legacy.bool("agentNotifyStarted", &agents.notifyStarted)
        legacy.bool("agentNotifyAttention", &agents.notifyAttention)
        legacy.bool("agentNotifyFinished", &agents.notifyFinished)
        legacy.bool("agentAutoExpandOnAttention", &agents.autoExpandOnAttention)
        legacy.bool("agentSystemNotifications", &agents.systemNotifications)
        legacy.bool("agentQuietWhenFocused", &agents.quietWhenFocused)
        legacy.bool("agentNotifySound", &agents.soundEnabled)
        legacy.string("agentSoundStarted", &agents.soundStarted)
        legacy.string("agentSoundAttention", &agents.soundAttention)
        legacy.string("agentSoundFinished", &agents.soundFinished)
        legacy.bool("agentUsageLimits", &agents.usageLimits)
        legacy.bool("agentPermissionApproval", &agents.permissionApproval)
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

private struct LegacyDefaults {
    let defaults: UserDefaults

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
}

/// The toggle-notch chord, a Carbon key code and modifier mask, that preference
/// documents from before KeyboardShortcuts store under `general`.
package struct LegacyHotkey {
    package let keyCode: Int
    package let modifiers: Int

    package init?(document data: Data) {
        guard let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let general = document["general"] as? [String: Any]
        else { return nil }
        self.init(values: general)
    }

    package init?(defaults: UserDefaults) {
        self.init(values: defaults.dictionaryRepresentation())
    }

    private init?(values: [String: Any]) {
        guard values["hotkeyKeyCode"] != nil || values["hotkeyModifiers"] != nil else { return nil }
        let keyCode = values["hotkeyKeyCode"] as? Int ?? 45
        let modifiers = values["hotkeyModifiers"] as? Int ?? 6144
        guard (0 ... Int(UInt16.max)).contains(keyCode),
              (0 ... Int(UInt32.max)).contains(modifiers)
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

    /// Read before load() can create the first document from older defaults.
    /// A document without a chord has already migrated; old defaults then stay ignored.
    package func legacyHotkey() -> LegacyHotkey? {
        do {
            if let data = try persistence.loadData(from: Self.fileName) {
                return LegacyHotkey(document: data)
            }
            return legacyDefaults.flatMap { LegacyHotkey(defaults: $0) }
        } catch {
            // load() reports the unreadable preferences file.
            return nil
        }
    }
}
