import AppKit
import ApplicationServices
import KeyboardShortcuts
import NotchCore
import SwiftUI

/// Content of the standard Settings window: System Settings-style toolbar tabs,
/// each a grouped Form binding directly to the shared `Settings` object.
struct SettingsView: View {
    @Bindable var settings: Settings
    @Environment(AgentManager.self) private var agents
    @Environment(MediaManager.self) private var media
    @Environment(AudioVisualizerManager.self) private var visualizer
    @Environment(ShortcutsManager.self) private var shortcuts
    @Environment(PowerModeController.self) private var powerMode
    @Environment(TrayManager.self) private var tray
    @Environment(Diagnostics.self) private var diagnostics

    @State private var shortcutToPin = ""
    @State private var t3PairingLink = ""
    @State private var t3Pairing = false
    @State private var displays: [DisplayDescriptor] = []
    @State private var customizedDisplayKey = ""

    var body: some View {
        TabView {
            Tab("General", systemImage: "gearshape") {
                pane { generalSection }
            }
            Tab("Notch", systemImage: "rectangle.tophalf.inset.filled") {
                pane {
                    notchLayoutSection
                    tabsSection
                    displaySection
                }
            }
            Tab("Widgets", systemImage: "square.grid.2x2") {
                widgetsPane
            }
            Tab("Media", systemImage: "play.circle") {
                pane { mediaSection }
            }
            Tab("System", systemImage: "slider.horizontal.3") {
                pane {
                    hudSection
                    batterySection
                }
            }
            Tab("Agents", systemImage: "terminal") {
                pane {
                    agentsSection
                    if settings.agents.enabled {
                        agentIntegrationsSection
                    }
                }
            }
            Tab("Tray", systemImage: "tray.full") {
                pane {
                    traySection
                    sharingSection
                }
            }
            Tab("Permissions", systemImage: "lock.shield") {
                pane { permissionsSection }
            }
            Tab("Diagnostics", systemImage: "stethoscope") {
                pane { diagnosticsSection }
            }
        }
        .frame(width: 580, height: 540)
        .onAppear { refreshDisplays() }
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didChangeScreenParametersNotification
        )) { _ in
            refreshDisplays()
        }
    }

    private func pane(@ViewBuilder _ content: () -> some View) -> some View {
        Form { content() }
            .formStyle(.grouped)
    }
}

extension SettingsView {
    // MARK: - Notch layout

    private var notchLayoutSection: some View {
        Section {
            Picker("Tab bar", selection: $settings.notch.tabBarStyle) {
                ForEach(TabBarStyle.allCases) { style in
                    Text(style.title).tag(style)
                }
            }
        } header: {
            Text("Layout")
        } footer: {
            Text(
                "Floating detaches the tab icons from the black panel into their own capsule under it. Shoulders draws them on the black band beside the cutout, in tab order, and gives the row back to the content."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Display

    private var tabsSection: some View {
        Section {
            ForEach(settings.notch.tabLayout) { tab in
                tabRow(tab, visible: true)
            }
            .onMove { settings.notch.tabLayout.move(fromOffsets: $0, toOffset: $1) }
            ForEach(NotchState.ExpandedTab.allCases.filter { !settings.isTabVisible($0) }) { tab in
                tabRow(tab, visible: false)
            }
            Picker("Opens on", selection: $settings.notch.defaultTab) {
                ForEach(settings.notch.tabLayout) { tab in
                    Text(tab.title).tag(tab)
                }
            }
        } header: {
            Text("Tabs")
        } footer: {
            Text(
                "Drag visible tabs to reorder them. Home always stays available — the panel falls back to it when the chosen tab is hidden."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func tabRow(_ tab: NotchState.ExpandedTab, visible: Bool) -> some View {
        HStack {
            Label(tab.title, systemImage: tab.symbol)
            Spacer()
            Toggle(tab.title, isOn: Binding(
                get: { visible },
                set: { settings.setTab(tab, visible: $0) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
            .disabled(tab == .home)
        }
    }

    private var displaySection: some View {
        Section {
            Picker("Show Notch on", selection: $settings.display.placement) {
                Text(DisplayPlacement.builtIn.title).tag(DisplayPlacement.builtIn)
                Text(DisplayPlacement.main.title).tag(DisplayPlacement.main)
                Text(DisplayPlacement.all.title).tag(DisplayPlacement.all)
            }
            // Keep the picker usable if an older/defaults-edited install ever
            // contains the otherwise invalid `all + follow active` combination.
            .disabled(settings.display.followActive && settings.display.placement != .all)

            Toggle("Only show on active display", isOn: $settings.display.followActive)
                .disabled(settings.display.placement == .all)

            if let display = selectedDisplay {
                Divider()
                Picker("Virtual notch", selection: $settings.display.virtualNotchMode) {
                    ForEach(VirtualNotchMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                VirtualNotchPreview(display: display, mode: settings.display.virtualNotchMode)
                Picker("Customize", selection: $customizedDisplayKey) {
                    ForEach(displays, id: \.key) { option in
                        Text(option.name).tag(option.key)
                    }
                }
                displaySlider(
                    "Compact width", value: profileBinding(\.compactWidthAdjustment),
                    range: display.hasPhysicalNotch ? 0 ... 160 : -40 ... 160, suffix: " pt"
                )
                displaySlider(
                    "Compact height", value: profileBinding(\.compactHeightAdjustment),
                    range: display.hasPhysicalNotch ? 0 ... 20 : -6 ... 20, suffix: " pt"
                )
                displaySlider(
                    "Expanded width", value: profileBinding(\.expandedWidthAdjustment),
                    range: -80 ... 180, suffix: " pt"
                )
                if !display.hasPhysicalNotch {
                    displaySlider(
                        "Horizontal offset", value: profileBinding(\.horizontalOffset),
                        range: -240 ... 240, suffix: " pt"
                    )
                    displaySlider(
                        "Top offset", value: profileBinding(\.verticalOffset),
                        range: 0 ... 80, suffix: " pt"
                    )
                }
                Toggle("Custom widget set on this display", isOn: customWidgetLayoutBinding(display.key))
                Picker("Opens on", selection: displayDefaultTabBinding(display.key)) {
                    Text("Same as everywhere").tag("")
                    ForEach(settings.notch.tabLayout) { tab in
                        Text(tab.title).tag(tab.rawValue)
                    }
                }
                Button("Reset Display Size and Position") {
                    settings.resetDisplayProfile(for: display.key)
                }
                .controlSize(.small)
            }
        } header: {
            Text("Display")
        } footer: {
            Text(
                "Automatic uses pill chrome on notchless screens. Physical camera housing space is always protected, including Always mode. Built-in falls back to the main display while unavailable."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private var selectedDisplay: DisplayDescriptor? {
        if let customized = displays.first(where: { $0.key == customizedDisplayKey }) {
            return customized
        }
        return DisplaySelectionPolicy.resolve(
            displays: displays, placement: settings.display.placement
        ).targets.first
    }

    private func profileBinding(_ keyPath: WritableKeyPath<DisplayProfile, Double>) -> Binding<Double> {
        Binding(
            get: {
                guard let display = selectedDisplay else { return 0 }
                return settings.displayProfile(for: display.key)[keyPath: keyPath]
            },
            set: { value in
                guard let display = selectedDisplay else { return }
                var profile = settings.displayProfile(for: display.key)
                profile[keyPath: keyPath] = value
                settings.updateDisplayProfile(profile)
            }
        )
    }

    /// Forks the global widget layout into a display override (or drops it).
    /// The forked set is then edited on that display's own home tab.
    private func customWidgetLayoutBinding(_ displayKey: String) -> Binding<Bool> {
        Binding(
            get: { settings.hasCustomWidgetLayout(for: displayKey) },
            set: { settings.setCustomWidgetLayout($0, for: displayKey) }
        )
    }

    private func displayDefaultTabBinding(_ displayKey: String) -> Binding<String> {
        Binding(
            get: { settings.displayProfile(for: displayKey).defaultTab ?? "" },
            set: { raw in
                var profile = settings.displayProfile(for: displayKey)
                profile.defaultTab = raw.isEmpty ? nil : raw
                settings.updateDisplayProfile(profile)
            }
        )
    }

    private func displaySlider(
        _ title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        suffix: String
    ) -> some View {
        LabeledContent(title) {
            HStack(spacing: 8) {
                Slider(value: value, in: range, step: 2)
                    .frame(width: 180)
                Text("\(Int(value.wrappedValue))\(suffix)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 48, alignment: .trailing)
            }
        }
    }

    private func refreshDisplays() {
        displays = DisplayInventory.current()
        if !displays.contains(where: { $0.key == customizedDisplayKey }) {
            customizedDisplayKey = DisplaySelectionPolicy.resolve(
                displays: displays, placement: settings.display.placement
            ).targets.first?.key ?? displays.first?.key ?? ""
        }
    }

    // MARK: - General

    private var generalSection: some View {
        Section("General") {
            Toggle("Launch at Login", isOn: Binding(
                get: { settings.launchesAtLogin },
                set: { settings.setLaunchAtLogin($0) }
            ))
            Toggle("Haptic feedback", isOn: $settings.general.hapticFeedback)
            Toggle("Toggle notch with a keyboard shortcut", isOn: $settings.general.hotkeyEnabled)
            if settings.general.hotkeyEnabled {
                KeyboardShortcuts.Recorder("Shortcut", name: .toggleNotch)
            }
            Button("Show Welcome Tour…") {
                NotificationCenter.default.post(name: .showOnboarding, object: nil)
            }
        }
    }
}

extension SettingsView {
    // MARK: - Agents

    private var agentsSection: some View {
        Section {
            Toggle("Watch coding agents", isOn: Binding(
                get: { settings.agents.enabled },
                set: { agents.setWatchingEnabled($0) }
            ))
            if settings.agents.enabled {
                Toggle("Notify when an agent needs you", isOn: $settings.agents.notifyAttention)
                Toggle("Notify when an agent finishes", isOn: $settings.agents.notifyFinished)
                Toggle("Notify when an agent starts", isOn: $settings.agents.notifyStarted)
                Toggle("Auto-expand on needs-you", isOn: $settings.agents.autoExpandOnAttention)
                Toggle("Stay quiet while its terminal is in front", isOn: $settings.agents.quietWhenFocused)
                // Approve/deny from the notch is switched off build-wide for now
                // (see AgentFeatures); the round-trip code stays in place.
                if AgentFeatures.permissionApproval {
                    Toggle("Approve permission prompts from the notch", isOn: $settings.agents.permissionApproval)
                    if settings.agents.permissionApproval {
                        Text(
                            "Claude waits up to 2 minutes for your decision here before falling back to the terminal prompt."
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
                Toggle("Claude usage limits", isOn: Binding(
                    get: { settings.agents.usageLimits },
                    set: { agents.setUsageLimits($0) }
                ))
                Toggle("System notifications", isOn: $settings.agents.systemNotifications)
                Toggle("Play 8-bit sounds", isOn: $settings.agents.soundEnabled)
                if settings.agents.soundEnabled {
                    soundPicker("Needs-you sound", $settings.agents.soundAttention)
                    soundPicker("Finished sound", $settings.agents.soundFinished)
                    soundPicker("Started sound", $settings.agents.soundStarted)
                }
            }
        } header: {
            Text("Agents")
        } footer: {
            Text("Turning Watch off pauses agent monitoring without removing installed integrations.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Agent integrations

    /// Per-agent opt-in: enabling installs that CLI's hooks so the notch can watch
    /// it. Lives here (not in the notch's Agents tab) so the tab stays a clean list
    /// of what's running.
    private var agentIntegrationsSection: some View {
        Section {
            ForEach(agents.availableKinds) { kind in
                agentIntegrationRow(kind)
            }
        } header: {
            Text("Coding agents")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let error = agents.integrationError {
                    PixelLabel(
                        title: error,
                        systemName: "exclamationmark.triangle.fill",
                        size: 13,
                        tint: .orange
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                Text(
                    "Enabling installs an agent's opt-in hooks (e.g. ~/.claude/settings.json) so the notch can watch it; disabling removes them."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func agentIntegrationRow(_ kind: AgentKind) -> some View {
        if kind == .t3code {
            // t3 has no hook install: it's paired with the local t3 server via a
            // one-time link, so this row is a paste field until connected. Never
            // gated on isInstalled — `npx t3` leaves nothing on disk to detect.
            t3IntegrationRow
        } else if agents.isInstalled(kind) {
            Toggle(isOn: Binding(
                get: { agents.isEnabled(kind) },
                set: { agents.setEnabled($0, for: kind) }
            )) {
                agentLabel(kind)
            }
        } else {
            LabeledContent {
                Text("Not installed").foregroundStyle(.secondary)
            } label: {
                agentLabel(kind)
            }
        }
    }

    private var t3IntegrationRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if agents.t3Environments.isEmpty {
                agentLabel(.t3code)
            } else {
                Toggle(isOn: Binding(
                    get: { agents.isEnabled(.t3code) },
                    set: { agents.setEnabled($0, for: .t3code) }
                )) {
                    agentLabel(.t3code)
                }
                ForEach(agents.t3Environments) { environment in
                    HStack(spacing: 8) {
                        Text(environment.label)
                        Text(environment.baseURL)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button {
                            agents.removeT3Environment(id: environment.id)
                        } label: {
                            PixelIcon(systemName: "minus.circle", size: 13, tint: .secondary)
                        }
                        .buttonStyle(.plain)
                        .help("Forget this server")
                    }
                    .padding(.leading, 12)
                }
            }
            HStack(spacing: 8) {
                TextField("Pairing link from t3 pair", text: $t3PairingLink)
                    .textFieldStyle(.roundedBorder)
                Button(t3Pairing ? "Connecting…" : "Connect") {
                    let link = t3PairingLink
                    t3Pairing = true
                    Task {
                        await agents.pairT3(link: link)
                        t3Pairing = false
                        if agents.integrationError == nil {
                            t3PairingLink = ""
                        }
                    }
                }
                .disabled(t3PairingLink.trimmingCharacters(in: .whitespaces).isEmpty || t3Pairing)
            }
        }
    }

    private func agentLabel(_ kind: AgentKind) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(kind.displayName)
            Text(summary(kind))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func summary(_ kind: AgentKind) -> String {
        switch kind {
        case .claudeCode:
            "Live status, needs-you, and finished. Adds fire-and-forget hooks to ~/.claude/settings.json."
        case .codex:
            "Live status, needs-you, and finished via ~/.codex/hooks.json (Codex asks you to trust the hook on first run)."
        case .openCode:
            "Live status + needs-you via a small plugin in ~/.config/opencode/plugins."
        case .ohMyPi:
            "Live status + needs-you via an extension in ~/.omp/agent/extensions."
        case .t3code:
            "Read-only view of t3 server sessions, local or remote. Run t3 pair on each server and paste the link; pair several to watch them all."
        }
    }

    private func soundPicker(_ title: String, _ selection: Binding<String>) -> some View {
        Picker(title, selection: selection) {
            Text("None").tag("")
            ForEach(AgentNotifier.availableSounds, id: \.self) { name in
                Text(name).tag(name)
            }
        }
        .onChange(of: selection.wrappedValue) { _, name in AgentNotifier.preview(name) }
    }
}

extension SettingsView {
    // MARK: - Media

    private var mediaSection: some View {
        Section("Media") {
            Toggle("Show compact Now Playing", isOn: $settings.media.compactNowPlaying)
            Toggle("Live three-band audio visualizer", isOn: Binding(
                get: { settings.media.audioVisualizer },
                set: { enabled in
                    settings.media.audioVisualizer = enabled
                    if enabled {
                        visualizer.requestPermission()
                    } else {
                        visualizer.setActive(false)
                    }
                }
            ))
            .disabled(!settings.media.compactNowPlaying)

            if settings.media.audioVisualizer {
                visualizerStatus
            }

            Toggle("System-wide Now Playing (adapter)", isOn: $settings.media.systemWideAdapter)
            if settings.media.systemWideAdapter {
                switch media.adapterState {
                case .starting:
                    PixelLabel(
                        title: "Checking the bundled adapter…",
                        systemName: "hourglass",
                        size: 13,
                        tint: .primary.opacity(0.6)
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                case .active:
                    PixelLabel(
                        title: "System-wide Now Playing is active",
                        systemName: "checkmark.circle.fill",
                        size: 13,
                        tint: .green
                    )
                    .font(.caption)
                    .foregroundStyle(.green)
                case .missing:
                    PixelLabel(
                        title: "The bundled adapter is missing; using Music and Spotify fallback.",
                        systemName: "exclamationmark.triangle.fill",
                        size: 13,
                        tint: .orange
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                case let .unavailable(reason):
                    PixelLabel(
                        title: reason,
                        systemName: "exclamationmark.triangle.fill",
                        size: 13,
                        tint: .orange
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                case .notRequested:
                    EmptyView()
                }
            }
            Text("The audited adapter is included with Notch. Changes to this toggle take effect after relaunch.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onAppear {
            visualizer.refreshPermissionState(required: settings.media.audioVisualizer)
        }
    }

    @ViewBuilder
    private var visualizerStatus: some View {
        switch visualizer.captureState {
        case .idle:
            Text("The meter captures only while compact Now Playing is visible and audio is playing.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .permissionRequired:
            LabeledContent {
                Button("Open") { PrivacyPane.screenRecording.open() }
                    .controlSize(.small)
            } label: {
                PixelLabel(
                    title: "Allow Screen & System Audio Recording",
                    systemName: "exclamationmark.triangle.fill",
                    size: 13,
                    tint: .orange
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
        case .starting:
            PixelLabel(
                title: "Starting live audio meter…",
                systemName: "hourglass",
                size: 13,
                tint: .primary.opacity(0.6)
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        case .active:
            PixelLabel(
                title: "Live audio meter is active",
                systemName: "checkmark.circle.fill",
                size: 13,
                tint: .green
            )
            .font(.caption)
            .foregroundStyle(.green)
        case let .failed(reason):
            PixelLabel(
                title: reason,
                systemName: "exclamationmark.triangle.fill",
                size: 13,
                tint: .orange
            )
            .font(.caption)
            .foregroundStyle(.orange)
        }
    }

    // MARK: - HUD

    @State private var accessibilityTrusted = AXIsProcessTrusted()

    private var hudSection: some View {
        Section {
            Toggle("Show volume/brightness HUD", isOn: $settings.hud.enabled)
            Toggle("Replace the system HUD", isOn: Binding(
                get: { settings.hud.replacesSystem },
                set: {
                    settings.hud.replacesSystem = $0
                    accessibilityTrusted = AXIsProcessTrusted()
                }
            ))
            .disabled(!settings.hud.enabled)
            if settings.hud.enabled, settings.hud.replacesSystem, !accessibilityTrusted {
                LabeledContent {
                    Button("Open") { PrivacyPane.accessibility.open() }
                        .controlSize(.small)
                } label: {
                    PixelLabel(
                        title: "Allow Accessibility access",
                        systemName: "exclamationmark.triangle.fill",
                        size: 13,
                        tint: .orange
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }
        } header: {
            Text("HUD")
        } footer: {
            Text(
                "Replacing intercepts the media keys and applies volume and brightness changes itself, so only Notch's HUD appears. Keys Notch can't drive (like external display brightness) fall back to the system."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .onAppear { accessibilityTrusted = AXIsProcessTrusted() }
    }

    // MARK: - Battery

    private var batterySection: some View {
        Section {
            Stepper(
                "Low battery alert at \(settings.widgets.lowBatteryThreshold)%",
                value: $settings.widgets.lowBatteryThreshold,
                in: 5 ... 50,
                step: 5
            )
            if powerMode.shortcutInstalled == true {
                PixelLabel(
                    title: "Low Power Mode shortcut installed",
                    systemName: "checkmark.circle.fill",
                    size: 13,
                    tint: .green
                )
                .font(.caption)
                .foregroundStyle(.green)
            } else {
                LabeledContent {
                    Button("Install…") { powerMode.installShortcut() }
                        .controlSize(.small)
                } label: {
                    Text("Low Power Mode shortcut")
                }
            }
        } header: {
            Text("Battery")
        } footer: {
            Text(
                "The battery tile's leaf toggles Low Power Mode through a Shortcuts action — macOS offers no direct control. Install adds the bundled \"\(PowerModeController.shortcutName)\" shortcut; approve the one-time import in Shortcuts."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .onAppear { powerMode.refreshAvailability() }
    }
}

extension SettingsView {
    // MARK: - Widgets

    private var widgetsPane: some View {
        List {
            widgetRowSection(
                .status,
                title: "Status tiles",
                footer: "Compact tiles along the top of the home tab. Drag to reorder. Battery and Bluetooth only appear when the hardware calls for them."
            )
            widgetRowSection(
                .info,
                title: "Info panels",
                footer: "Taller panels below the tiles. Drag to reorder; the order here is the order on the home tab."
            )

            if settings.isWidgetEnabled(.weather) {
                Section("Weather") {
                    Picker("Units", selection: $settings.widgets.temperatureUnit) {
                        Text(WeatherSnapshot.TemperatureUnit.celsius.suffix)
                            .tag(WeatherSnapshot.TemperatureUnit.celsius)
                        Text(WeatherSnapshot.TemperatureUnit.fahrenheit.suffix)
                            .tag(WeatherSnapshot.TemperatureUnit.fahrenheit)
                    }
                }
            }
            if settings.isWidgetEnabled(.clock) {
                Section("Clock") {
                    TextField(
                        "Second time zone",
                        text: $settings.widgets.clockSecondaryTimeZone,
                        prompt: Text("e.g. Europe/Berlin (optional)")
                    )
                }
            }
            if settings.isWidgetEnabled(.shortcuts) {
                Section("Shortcuts") {
                    pinnedShortcutsEditor
                }
            }
        }
        .listStyle(.inset)
    }

    /// One grid row of the home tab: enabled widgets in their layout order,
    /// draggable like the tiles in Notification Center, then the row's disabled
    /// ones. Turning a widget on appends it to the end of its row.
    private func widgetRowSection(_ row: WidgetKind.Row, title: String, footer: String) -> some View {
        let enabled = settings.notch.widgetLayout.filter { $0.row == row }
        let disabled = WidgetKind.allCases.filter { $0.row == row && !enabled.contains($0) }
        return Section {
            ForEach(enabled) { kind in
                widgetRow(kind, isOn: widgetBinding(kind))
            }
            .onMove { source, destination in
                guard let from = source.first else { return }
                let target = destination > from ? destination - 1 : destination
                withAnimation { settings.moveWidget(enabled[from], by: target - from) }
            }
            ForEach(disabled) { kind in
                widgetRow(kind, isOn: widgetBinding(kind))
                    .moveDisabled(true)
            }
        } header: {
            Text(title)
        } footer: {
            Text(footer)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func widgetBinding(_ kind: WidgetKind) -> Binding<Bool> {
        Binding(
            get: { settings.isWidgetEnabled(kind) },
            set: { settings.setWidget(kind, enabled: $0) }
        )
    }

    private func widgetRow(_ kind: WidgetKind, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(kind.tint.gradient)
                .frame(width: 30, height: 30)
                .overlay {
                    PixelIcon(systemName: kind.symbol, size: 16, tint: .white)
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(kind.title)
                    .font(.system(size: 13, weight: .semibold))
                Text(kind.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Toggle(kind.title, isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
        .padding(.vertical, 3)
        .opacity(isOn.wrappedValue ? 1 : 0.6)
    }

    private var pinnedShortcutsEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(settings.widgets.pinnedShortcuts, id: \.self) { name in
                HStack {
                    Text(name)
                    Spacer()
                    Button {
                        settings.widgets.pinnedShortcuts.removeAll { $0 == name }
                    } label: {
                        PixelIcon(
                            systemName: "minus.circle.fill",
                            size: 13,
                            tint: .primary.opacity(0.6)
                        )
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Unpin \(name)")
                }
            }

            HStack {
                Picker("Pin a shortcut", selection: $shortcutToPin) {
                    Text("Choose…").tag("")
                    ForEach(
                        shortcuts.available.filter { !settings.widgets.pinnedShortcuts.contains($0) },
                        id: \.self
                    ) { name in
                        Text(name).tag(name)
                    }
                }
                .labelsHidden()
                Button("Pin") {
                    guard !shortcutToPin.isEmpty else { return }
                    settings.widgets.pinnedShortcuts.append(shortcutToPin)
                    shortcutToPin = ""
                }
                .disabled(shortcutToPin.isEmpty)
            }
        }
        .onAppear { shortcuts.refreshAvailable() }
    }

    // MARK: - Tray

    private var traySection: some View {
        Section("Tray") {
            Stepper(
                "Keep files for \(settings.tray.ttlDays) days",
                value: $settings.tray.ttlDays,
                in: 1 ... 90
            )
            Button("Apply to Existing Unpinned Items") {
                tray.applyGlobalTTLToExistingItems()
            }
            Toggle("Allow Option-drag to move originals", isOn: $settings.tray.moveEnabled)
            Text("When enabled, Option-drop removes eligible originals only after Notch verifies its managed copy.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle("Offer new screenshots in Notch", isOn: $settings.tray.offerScreenshots)
            Text(
                "Watches only your configured screenshot folder and never copies a screenshot until you choose Add to Shelf."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Sharing

    private var sharingSection: some View {
        Section {
            Picker("Share files with", selection: $settings.tray.shareMethod) {
                ForEach(ShareMethod.allCases) { method in
                    Text(method.title).tag(method)
                }
            }
        } header: {
            Text("Sharing")
        } footer: {
            Text(
                "Used when you drop a file on the notch's share zone. Blip must be installed and offer a macOS share option."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

extension SettingsView {
    // MARK: - Permissions

    private var permissionsSection: some View {
        Section {
            ForEach(PrivacyPane.allCases) { pane in
                LabeledContent {
                    Button("Open") { pane.open() }
                        .controlSize(.small)
                } label: {
                    HStack(spacing: 7) {
                        if let granted = Self.status(of: pane) {
                            Circle()
                                .fill(granted ? Color.green : Color.orange)
                                .frame(width: 7, height: 7)
                                .accessibilityLabel(granted ? "Granted" : "Not granted")
                        }
                        Text(pane.title)
                    }
                }
            }
        } header: {
            Text("Permissions")
        } footer: {
            Text(
                "Opens the matching pane in System Settings so you can grant access. Input Monitoring (or Accessibility for HUD replacement) is what lets the volume and brightness keys reach Notch; a grant may need an app relaunch to take effect."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private var diagnosticsSection: some View {
        Section {
            if diagnostics.issues.isEmpty {
                Text("Nothing has gone wrong since launch.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(diagnostics.issues) { issue in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(issue.source).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(issue.date, style: .time)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(issue.message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 2)
                }
                Button("Clear") { diagnostics.clear() }
                    .controlSize(.small)
            }
        } header: {
            Text("Recent problems")
        } footer: {
            Text(
                "Failures Notch recovered from on its own: files that would not read or write, agent hooks it could not install. Each one is also in Console under the com.aquitano.notch subsystem."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    /// Live grant state for the panes the system lets us query cheaply; nil for
    /// the rest (their state only shows up when the feature actually asks).
    private static func status(of pane: PrivacyPane) -> Bool? {
        switch pane {
        case .inputMonitoring: CGPreflightListenEventAccess()
        case .accessibility: AXIsProcessTrusted()
        default: nil
        }
    }
}

private struct VirtualNotchPreview: View {
    let display: DisplayDescriptor
    let mode: VirtualNotchMode

    private var virtual: Bool {
        mode.usesVirtualChrome(for: display)
    }

    private var description: String {
        if display.hasPhysicalNotch {
            return virtual ? "Virtual chrome around physical notch" : "Physical notch chrome"
        }
        return virtual ? "Detached virtual pill" : "Top-edge notch"
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .top) {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(.black.opacity(0.14))
                if virtual {
                    Capsule()
                        .fill(.black)
                        .frame(width: 48, height: 13)
                        .padding(.top, 5)
                } else {
                    UnevenRoundedRectangle(
                        bottomLeadingRadius: 6, bottomTrailingRadius: 6
                    )
                    .fill(.black)
                    .frame(width: 48, height: 13)
                }
                if display.hasPhysicalNotch {
                    Capsule()
                        .fill(.gray.opacity(0.65))
                        .frame(width: 22, height: 3)
                        .padding(.top, virtual ? 8 : 3)
                }
            }
            .frame(width: 92, height: 48)
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(.secondary.opacity(0.25), lineWidth: 1)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(display.name)
                    .lineLimit(1)
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(display.name), \(description)")
    }
}

/// The System Settings privacy panes this app may need, with best-effort deep
/// links. The URLs target the legacy security preference but still route to the
/// right pane on current macOS.
private enum PrivacyPane: String, CaseIterable, Identifiable {
    case inputMonitoring
    case accessibility
    case screenRecording
    case calendars
    case automation
    case location

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .inputMonitoring: "Input Monitoring"
        case .accessibility: "Accessibility"
        case .screenRecording: "Screen & System Audio Recording"
        case .calendars: "Calendars"
        case .automation: "Automation"
        case .location: "Location Services"
        }
    }

    private var urlString: String {
        let base = "x-apple.systempreferences:com.apple.preference.security?"
        switch self {
        case .inputMonitoring: return base + "Privacy_ListenEvent"
        case .accessibility: return base + "Privacy_Accessibility"
        case .screenRecording: return base + "Privacy_ScreenCapture"
        case .calendars: return base + "Privacy_Calendars"
        case .automation: return base + "Privacy_Automation"
        case .location: return base + "Privacy_LocationServices"
        }
    }

    func open() {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }
}
