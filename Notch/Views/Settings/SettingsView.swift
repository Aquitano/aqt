import SwiftUI
import AppKit

/// Content of the standard Settings window. A grouped Form that binds directly
/// to the shared `Settings` object; the login-item toggle additionally syncs the
/// real `SMAppService` registration so the preference and the OS agree.
struct SettingsView: View {
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var agents: AgentManager
    @EnvironmentObject private var media: MediaManager

    var body: some View {
        Form {
            generalSection
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
            // Build providers + the socket the moment the feature is switched on;
            // binding straight to the setting left it a no-op until relaunch.
            Toggle("Watch coding agents", isOn: Binding(
                get: { settings.agentsEnabled },
                set: { on in
                    settings.agentsEnabled = on
                    if on { agents.start() }
                }
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
                Toggle("Play a sound", isOn: $settings.agentNotifySound)
                if settings.agentNotifySound {
                    soundPicker("Needs-you sound", $settings.agentSoundAttention)
                    soundPicker("Finished sound", $settings.agentSoundFinished)
                    soundPicker("Started sound", $settings.agentSoundStarted)
                }
            }
        } header: {
            Text("Agents")
        } footer: {
            Text("Turning Watch off takes effect on relaunch.")
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
                    Label(error, systemImage: "exclamationmark.triangle.fill")
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
            Toggle("System-wide Now Playing (adapter)", isOn: $settings.enableMediaAdapter)
            if settings.enableMediaAdapter, case .unavailable(let reason) = media.adapterState {
                Label(reason, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            Text("Requires the bundled perl bridge (see README) and a relaunch to take effect.")
                .font(.caption)
                .foregroundStyle(.secondary)
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
        }
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

/// The System Settings privacy panes this app may need, with best-effort deep
/// links. The URLs target the legacy security preference but still route to the
/// right pane on current macOS.
private enum PrivacyPane: String, CaseIterable, Identifiable {
    case inputMonitoring
    case calendars
    case automation
    case location

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inputMonitoring: return "Input Monitoring"
        case .calendars: return "Calendars"
        case .automation: return "Automation"
        case .location: return "Location Services"
        }
    }

    private var urlString: String {
        let base = "x-apple.systempreferences:com.apple.preference.security?"
        switch self {
        case .inputMonitoring: return base + "Privacy_ListenEvent"
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
