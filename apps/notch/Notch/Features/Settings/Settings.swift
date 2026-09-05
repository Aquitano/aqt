import Foundation
import NotchCore
import Observation

/// Live, observable preferences. Each group is its own tracked property so a
/// view or observer that reads only `display` is not invalidated by an agent
/// toggle. Every mutation persists the whole document.
@MainActor
@Observable
final class Settings {
    var general: Preferences.General {
        didSet { generalChanged(from: oldValue) }
    }

    var notch: Preferences.Notch {
        didSet { persist() }
    }

    var display: Preferences.Display {
        didSet { persist() }
    }

    var hud: Preferences.HUD {
        didSet { persist() }
    }

    var media: Preferences.Media {
        didSet { persist() }
    }

    var tray: Preferences.Tray {
        didSet { persist() }
    }

    var widgets: Preferences.Widgets {
        didSet { persist() }
    }

    var agents: Preferences.Agents {
        didSet { persist() }
    }

    /// True while the Settings recorder is capturing a chord. Not persisted;
    /// the AppDelegate suspends the live registration so the current chord can
    /// be re-typed without toggling the notch.
    var isRecordingHotkey = false

    @ObservationIgnored private let store: PreferencesStore

    init(store: PreferencesStore) {
        self.store = store
        var loaded = store.load()
        // Trust the OS registration over the stored bool so a login item the user
        // removed in System Settings isn't silently re-shown as enabled.
        loaded.general.launchAtLogin = LoginItem.isEnabled
        general = loaded.general
        notch = loaded.notch
        display = loaded.display
        hud = loaded.hud
        media = loaded.media
        tray = loaded.tray
        widgets = loaded.widgets
        agents = loaded.agents
        Haptics.isEnabled = general.hapticFeedback
    }

    var snapshot: Preferences {
        Preferences(
            general: general,
            notch: notch,
            display: display,
            hud: hud,
            media: media,
            tray: tray,
            widgets: widgets,
            agents: agents
        )
    }

    private func persist() {
        store.save(snapshot)
    }

    private func generalChanged(from old: Preferences.General) {
        if general.launchAtLogin != old.launchAtLogin {
            LoginItem.setEnabled(general.launchAtLogin)
        }
        Haptics.isEnabled = general.hapticFeedback
        persist()
    }

    // MARK: - Tabs

    /// The tab the panel actually opens on: the configured default, unless it is
    /// hidden or the agents feature backing it is off.
    var resolvedDefaultTab: NotchState.ExpandedTab {
        let tab = notch.defaultTab
        guard notch.tabLayout.contains(tab), tab != .agents || agents.enabled else { return .home }
        return tab
    }

    func isTabVisible(_ tab: NotchState.ExpandedTab) -> Bool {
        notch.tabLayout.contains(tab)
    }

    func setTab(_ tab: NotchState.ExpandedTab, visible: Bool) {
        guard tab != .home else { return }
        if visible {
            guard !notch.tabLayout.contains(tab) else { return }
            notch.tabLayout.append(tab)
        } else {
            notch.tabLayout.removeAll { $0 == tab }
            if notch.defaultTab == tab {
                notch.defaultTab = .home
            }
        }
    }

    // MARK: - Widgets

    /// Widgets occupying the expanded home's info row. Drives both the grid and
    /// the panel height, so the two can never disagree about an empty row.
    var hasInfoRowWidgets: Bool {
        notch.widgetLayout.contains { $0.row == .info }
    }

    func isWidgetEnabled(_ kind: WidgetKind) -> Bool {
        notch.widgetLayout.contains(kind)
    }

    func setWidget(_ kind: WidgetKind, enabled: Bool) {
        notch.widgetLayout = Self.applying(kind, enabled: enabled, to: notch.widgetLayout)
    }

    /// Shifts a widget by whole slots within its own row, leaving the other
    /// row's ordering untouched.
    func moveWidget(_ kind: WidgetKind, by slots: Int) {
        notch.widgetLayout = Self.moving(kind, by: slots, in: notch.widgetLayout)
    }

    private static func applying(_ kind: WidgetKind, enabled: Bool, to layout: [WidgetKind]) -> [WidgetKind] {
        var layout = layout
        if enabled {
            if !layout.contains(kind) {
                layout.append(kind)
            }
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
        overrideWidgetLayout(for: displayKey) ?? notch.widgetLayout
    }

    func hasInfoRowWidgets(for displayKey: String) -> Bool {
        widgetLayout(for: displayKey).contains { $0.row == .info }
    }

    func hasCustomWidgetLayout(for displayKey: String) -> Bool {
        display.profiles.first { $0.displayKey == displayKey }?.widgetLayout != nil
    }

    /// Fork the current global layout into a display override, or drop the
    /// override so the display follows the global layout again.
    func setCustomWidgetLayout(_ custom: Bool, for displayKey: String) {
        var profile = displayProfile(for: displayKey)
        profile.widgetLayout = custom ? notch.widgetLayout.map(\.rawValue) : nil
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
        guard let raw = display.profiles.first(where: { $0.displayKey == displayKey })?.defaultTab,
              let tab = NotchState.ExpandedTab(rawValue: raw),
              notch.tabLayout.contains(tab), tab != .agents || agents.enabled
        else { return resolvedDefaultTab }
        return tab
    }

    private func overrideWidgetLayout(for displayKey: String) -> [WidgetKind]? {
        display.profiles.first { $0.displayKey == displayKey }?.widgetLayout?
            .compactMap(WidgetKind.init(rawValue:))
    }

    private func storeWidgetOverride(_ layout: [WidgetKind], for displayKey: String) {
        var profile = displayProfile(for: displayKey)
        profile.widgetLayout = layout.map(\.rawValue)
        updateDisplayProfile(profile)
    }

    func displayProfile(for displayKey: String) -> DisplayProfile {
        display.profiles.first(where: { $0.displayKey == displayKey })
            ?? .standard(for: displayKey)
    }

    func updateDisplayProfile(_ profile: DisplayProfile) {
        let profile = profile.normalized
        display.profiles.removeAll { $0.displayKey == profile.displayKey }
        display.profiles.append(profile)
    }

    /// Resets a display's geometry adjustments while keeping its widget/tab
    /// overrides (the Settings button only promises size and position).
    func resetDisplayProfile(for displayKey: String) {
        guard let existing = display.profiles.first(where: { $0.displayKey == displayKey }) else { return }
        var profile = DisplayProfile.standard(for: displayKey)
        profile.widgetLayout = existing.widgetLayout
        profile.defaultTab = existing.defaultTab
        if profile == .standard(for: displayKey) {
            display.profiles.removeAll { $0.displayKey == displayKey }
        } else {
            updateDisplayProfile(profile)
        }
    }
}
