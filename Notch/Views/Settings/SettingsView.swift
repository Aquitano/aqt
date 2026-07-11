import SwiftUI
import AppKit

/// Content of the standard Settings window. A grouped Form that binds directly
/// to the shared `Settings` object; the login-item toggle additionally syncs the
/// real `SMAppService` registration so the preference and the OS agree.
struct SettingsView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var agents: AgentManager
    @EnvironmentObject private var media: MediaManager
    @EnvironmentObject private var visualizer: AudioVisualizerManager
    @EnvironmentObject private var shortcuts: ShortcutsManager

    @State private var shortcutToPin = ""
    @State private var displays: [DisplayDescriptor] = []
    @State private var customizedDisplayKey = ""

    var body: some View {
        Form {
            generalSection
            displaySection
            agentsSection
            if settings.agentsEnabled {
                agentIntegrationsSection
            }
            mediaSection
            hudSection
            widgetsSection
            traySection
            sharingSection
            permissionsSection
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 560)
        .onAppear { refreshDisplays() }
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didChangeScreenParametersNotification
        )) { _ in
            refreshDisplays()
        }
    }

    // MARK: - Display

    private var displaySection: some View {
        Section {
            Picker("Show Notch on", selection: $settings.displayPlacement) {
                Text(DisplayPlacement.builtIn.title).tag(DisplayPlacement.builtIn)
                Text(DisplayPlacement.main.title).tag(DisplayPlacement.main)
                Text(DisplayPlacement.all.title).tag(DisplayPlacement.all)
            }
            // Keep the picker usable if an older/defaults-edited install ever
            // contains the otherwise invalid `all + follow active` combination.
            .disabled(settings.followActiveDisplay && settings.displayPlacement != .all)

            Toggle("Only show on active display", isOn: $settings.followActiveDisplay)
                .disabled(settings.displayPlacement == .all)

            if let display = selectedDisplay {
                Divider()
                Picker("Virtual notch", selection: $settings.virtualNotchMode) {
                    ForEach(VirtualNotchMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                VirtualNotchPreview(display: display, mode: settings.virtualNotchMode)
                Picker("Customize", selection: $customizedDisplayKey) {
                    ForEach(displays, id: \.key) { option in
                        Text(option.name).tag(option.key)
                    }
                }
                displaySlider(
                    "Compact width", value: profileBinding(\.compactWidthAdjustment),
                    range: display.hasPhysicalNotch ? 0...160 : -40...160, suffix: " pt"
                )
                displaySlider(
                    "Compact height", value: profileBinding(\.compactHeightAdjustment),
                    range: display.hasPhysicalNotch ? 0...20 : -6...20, suffix: " pt"
                )
                displaySlider(
                    "Expanded width", value: profileBinding(\.expandedWidthAdjustment),
                    range: -80...180, suffix: " pt"
                )
                if !display.hasPhysicalNotch {
                    displaySlider(
                        "Horizontal offset", value: profileBinding(\.horizontalOffset),
                        range: -240...240, suffix: " pt"
                    )
                    displaySlider(
                        "Top offset", value: profileBinding(\.verticalOffset),
                        range: 0...80, suffix: " pt"
                    )
                }
                Button("Reset Display Size and Position") {
                    settings.resetDisplayProfile(for: display.key)
                }
                .controlSize(.small)
            }
        } header: {
            Text("Display")
        } footer: {
            Text("Automatic uses pill chrome on notchless screens. Physical camera housing space is always protected, including Always mode. Built-in falls back to the main display while unavailable.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var selectedDisplay: DisplayDescriptor? {
        if let customized = displays.first(where: { $0.key == customizedDisplayKey }) {
            return customized
        }
        return DisplaySelectionPolicy.resolve(
            displays: displays, placement: settings.displayPlacement
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
                displays: displays, placement: settings.displayPlacement
            ).targets.first?.key ?? displays.first?.key ?? ""
        }
    }

    // MARK: - General

    private var generalSection: some View {
        Section("General") {
            // The SMAppService registration is driven from the Settings model, so
            // this toggle and the in-notch one stay in sync.
            Toggle("Launch at Login", isOn: $settings.launchAtLogin)
            Toggle("Haptic feedback", isOn: $settings.hapticFeedback)
            Toggle("Toggle notch with ⌃⌥N", isOn: $settings.hotkeyEnabled)
            Button("Show Welcome Tour…") {
                NotificationCenter.default.post(name: .showOnboarding, object: nil)
            }
        }
    }

    // MARK: - Agents

    private var agentsSection: some View {
        Section {
            Toggle("Watch coding agents", isOn: Binding(
                get: { settings.agentsEnabled },
                set: { agents.setWatchingEnabled($0) }
            ))
            if settings.agentsEnabled {
                Toggle("Notify when an agent needs you", isOn: $settings.agentNotifyAttention)
                Toggle("Notify when an agent finishes", isOn: $settings.agentNotifyFinished)
                Toggle("Notify when an agent starts", isOn: $settings.agentNotifyStarted)
                Toggle("Auto-expand on needs-you", isOn: $settings.agentAutoExpandOnAttention)
                Toggle("Approve permission prompts from the notch", isOn: $settings.agentPermissionApproval)
                if settings.agentPermissionApproval {
                    Text("Claude waits up to 2 minutes for your decision here before falling back to the terminal prompt.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Toggle("Claude usage limits", isOn: Binding(
                    get: { settings.agentUsageLimits },
                    set: { agents.setUsageLimits($0) }
                ))
                Toggle("System notifications", isOn: $settings.agentSystemNotifications)
                Toggle("Play 8-bit sounds", isOn: $settings.agentNotifySound)
                if settings.agentNotifySound {
                    soundPicker("Needs-you sound", $settings.agentSoundAttention)
                    soundPicker("Finished sound", $settings.agentSoundFinished)
                    soundPicker("Started sound", $settings.agentSoundStarted)
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
                    PixelLabel(title: error, systemName: "exclamationmark.triangle.fill",
                               size: 13, tint: .orange)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text("Enabling installs an agent's opt-in hooks (e.g. ~/.claude/settings.json) so the notch can watch it; disabling removes them.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func agentIntegrationRow(_ kind: AgentKind) -> some View {
        if agents.isInstalled(kind) {
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
            return "Live status, needs-you, and finished. Adds fire-and-forget hooks to ~/.claude/settings.json."
        case .codex:
            return "Live status, needs-you, and finished via ~/.codex/hooks.json (Codex asks you to trust the hook on first run)."
        case .openCode:
            return "Live status + needs-you via a small plugin in ~/.config/opencode/plugins."
        case .ohMyPi:
            return "Live status + needs-you via an extension in ~/.omp/agent/extensions."
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

    // MARK: - Media

    private var mediaSection: some View {
        Section("Media") {
            Toggle("Show compact Now Playing", isOn: $settings.showCompactNowPlaying)
            Toggle("Live three-band audio visualizer", isOn: Binding(
                get: { settings.showAudioVisualizer },
                set: { enabled in
                    settings.showAudioVisualizer = enabled
                    if enabled {
                        visualizer.requestPermission()
                    } else {
                        visualizer.setActive(false)
                    }
                }
            ))
            .disabled(!settings.showCompactNowPlaying)

            if settings.showAudioVisualizer {
                visualizerStatus
            }

            Toggle("System-wide Now Playing (adapter)", isOn: $settings.enableMediaAdapter)
            if settings.enableMediaAdapter {
                switch media.adapterState {
                case .starting:
                    PixelLabel(title: "Checking the bundled adapter…", systemName: "hourglass",
                               size: 13, tint: .primary.opacity(0.6))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .active:
                    PixelLabel(title: "System-wide Now Playing is active",
                               systemName: "checkmark.circle.fill", size: 13, tint: .green)
                        .font(.caption)
                        .foregroundStyle(.green)
                case .missing:
                    PixelLabel(title: "The bundled adapter is missing; using Music and Spotify fallback.",
                               systemName: "exclamationmark.triangle.fill", size: 13, tint: .orange)
                        .font(.caption)
                        .foregroundStyle(.orange)
                case .unavailable(let reason):
                    PixelLabel(title: reason, systemName: "exclamationmark.triangle.fill",
                               size: 13, tint: .orange)
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
            visualizer.refreshPermissionState(required: settings.showAudioVisualizer)
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
            PixelLabel(title: "Starting live audio meter…", systemName: "hourglass",
                       size: 13, tint: .primary.opacity(0.6))
                .font(.caption)
                .foregroundStyle(.secondary)
        case .active:
            PixelLabel(title: "Live audio meter is active", systemName: "checkmark.circle.fill",
                       size: 13, tint: .green)
                .font(.caption)
                .foregroundStyle(.green)
        case .failed(let reason):
            PixelLabel(title: reason, systemName: "exclamationmark.triangle.fill",
                       size: 13, tint: .orange)
                .font(.caption)
                .foregroundStyle(.orange)
        }
    }

    // MARK: - HUD

    private var hudSection: some View {
        Section("HUD") {
            Toggle("Show volume/brightness HUD", isOn: $settings.showHUD)
        }
    }

    // MARK: - Widgets

    private var widgetsSection: some View {
        Section("Widgets") {
            Toggle("Calendar", isOn: $settings.showCalendarWidget)
            Toggle("Weather", isOn: $settings.showWeatherWidget)

            Picker("Units", selection: $settings.temperatureUnit) {
                Text(WeatherSnapshot.TemperatureUnit.celsius.suffix)
                    .tag(WeatherSnapshot.TemperatureUnit.celsius)
                Text(WeatherSnapshot.TemperatureUnit.fahrenheit.suffix)
                    .tag(WeatherSnapshot.TemperatureUnit.fahrenheit)
            }

            Toggle("Clock", isOn: $settings.showClockWidget)
            if settings.showClockWidget {
                TextField("Second time zone", text: $settings.clockSecondaryTimeZone,
                          prompt: Text("e.g. Europe/Berlin (optional)"))
            }

            Toggle("Shortcuts", isOn: $settings.showShortcutsWidget)
            if settings.showShortcutsWidget {
                pinnedShortcutsEditor
            }

            Toggle("Quick note", isOn: $settings.showNoteWidget)
        }
    }

    private var pinnedShortcutsEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(settings.pinnedShortcuts, id: \.self) { name in
                HStack {
                    Text(name)
                    Spacer()
                    Button {
                        settings.pinnedShortcuts.removeAll { $0 == name }
                    } label: {
                        PixelIcon(systemName: "minus.circle.fill", size: 13,
                                  tint: .primary.opacity(0.6))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Unpin \(name)")
                }
            }

            HStack {
                Picker("Pin a shortcut", selection: $shortcutToPin) {
                    Text("Choose…").tag("")
                    ForEach(shortcuts.available.filter { !settings.pinnedShortcuts.contains($0) },
                            id: \.self) { name in
                        Text(name).tag(name)
                    }
                }
                .labelsHidden()
                Button("Pin") {
                    guard !shortcutToPin.isEmpty else { return }
                    settings.pinnedShortcuts.append(shortcutToPin)
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
                "Keep files for \(settings.trayTTLDays) days",
                value: $settings.trayTTLDays,
                in: 1...90
            )
        }
    }

    // MARK: - Sharing

    private var sharingSection: some View {
        Section {
            Picker("Share files with", selection: $settings.shareMethod) {
                ForEach(ShareMethod.allCases) { method in
                    Text(method.title).tag(method)
                }
            }
        } header: {
            Text("Sharing")
        } footer: {
            Text("Used when you drop a file on the notch's share zone. Blip must be installed and offer a macOS share option.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Permissions

    private var permissionsSection: some View {
        Section {
            ForEach(PrivacyPane.allCases) { pane in
                LabeledContent(pane.title) {
                    Button("Open") { pane.open() }
                        .controlSize(.small)
                }
            }
        } header: {
            Text("Permissions")
        } footer: {
            Text("Opens the matching pane in System Settings so you can grant access.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct VirtualNotchPreview: View {
    let display: DisplayDescriptor
    let mode: VirtualNotchMode

    private var virtual: Bool { mode.usesVirtualChrome(for: display) }

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
    case screenRecording
    case calendars
    case automation
    case location

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inputMonitoring: return "Input Monitoring"
        case .screenRecording: return "Screen & System Audio Recording"
        case .calendars: return "Calendars"
        case .automation: return "Automation"
        case .location: return "Location Services"
        }
    }

    private var urlString: String {
        let base = "x-apple.systempreferences:com.apple.preference.security?"
        switch self {
        case .inputMonitoring: return base + "Privacy_ListenEvent"
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
