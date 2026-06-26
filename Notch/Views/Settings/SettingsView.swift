import SwiftUI
import AppKit
import ServiceManagement

/// Content of the standard Settings window. A grouped Form that binds directly
/// to the shared `Settings` object; the login-item toggle additionally syncs the
/// real `SMAppService` registration so the preference and the OS agree.
struct SettingsView: View {
    @EnvironmentObject private var settings: Settings

    var body: some View {
        Form {
            generalSection
            mediaSection
            hudSection
            widgetsSection
            traySection
            permissionsSection
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 560)
    }

    // MARK: - General

    private var generalSection: some View {
        Section("General") {
            Toggle("Launch at Login", isOn: $settings.launchAtLogin)
                .onChange(of: settings.launchAtLogin) { _, enabled in
                    syncLoginItem(enabled)
                }

            Toggle("Haptic feedback", isOn: $settings.hapticFeedback)
        }
    }

    private func syncLoginItem(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // Registration can fail if the user revoked the login item in System
            // Settings; the stored preference still reflects intent.
        }
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
