import SwiftUI
import AppKit

/// Content of the standard Settings window. A grouped Form that binds directly
/// to the shared `Settings` object; the login-item toggle additionally syncs the
/// real `SMAppService` registration so the preference and the OS agree.
struct SettingsView: View {
    @EnvironmentObject private var settings: Settings

    var body: some View {
        Form {
            generalSection
            agentsSection
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
        }
    }

    // MARK: - Agents

    private var agentsSection: some View {
        Section {
            Toggle("Watch coding agents", isOn: $settings.agentsEnabled)
            if settings.agentsEnabled {
                Toggle("Notify when an agent needs you", isOn: $settings.agentNotifyAttention)
                Toggle("Notify when an agent finishes", isOn: $settings.agentNotifyFinished)
                Toggle("Notify when an agent starts", isOn: $settings.agentNotifyStarted)
                Toggle("Auto-expand on needs-you", isOn: $settings.agentAutoExpandOnAttention)
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
            Text("Enable a specific agent from the Agents tab in the notch — that writes its opt-in hooks. Turning Watch off takes effect on relaunch.")
                .font(.caption)
                .foregroundStyle(.secondary)
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
