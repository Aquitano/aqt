import SwiftUI
import CoreLocation
import EventKit

/// First-run welcome: what the notch does, guided permission grants, and the
/// two most consequential toggles. Everything here is skippable — each feature
/// keeps its own lazy in-place prompt, so this is a shortcut, not a gate.
struct OnboardingView: View {
    @Environment(Settings.self) private var settings
    @Environment(CalendarManager.self) private var calendar
    @Environment(WeatherManager.self) private var weather
    @Environment(FocusManager.self) private var focus
    @Environment(AgentManager.self) private var agents

    let onFinish: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.top, 28)
                .padding(.bottom, 20)

            VStack(spacing: 10) {
                permissionRow(
                    symbol: "calendar", title: "Calendar",
                    subtitle: "Upcoming events and time-to-leave reminders.",
                    granted: calendar.authorization == .fullAccess
                ) { Task { await calendar.requestAccess() } }

                permissionRow(
                    symbol: "location", title: "Location",
                    subtitle: "Local weather in the dashboard.",
                    granted: weather.authorization == .authorizedAlways
                ) { weather.requestAccess() }

                permissionRow(
                    symbol: "moon", title: "Focus",
                    subtitle: "Show your Focus status in the notch.",
                    granted: focus.authorized
                ) { focus.requestAccess() }
            }
            .padding(.horizontal, 24)

            Divider()
                .padding(.horizontal, 24)
                .padding(.vertical, 16)

            VStack(spacing: 10) {
                Toggle(isOn: Bindable(settings).launchAtLogin) {
                    toggleLabel(symbol: "power", title: "Launch at login",
                                subtitle: "Start the notch when you log in.")
                }
                Toggle(isOn: agentsEnabledBinding) {
                    toggleLabel(symbol: "terminal", title: "Watch coding agents",
                                subtitle: "Follow Claude Code, Codex, and friends from the notch.")
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .padding(.horizontal, 24)

            Spacer(minLength: 20)

            Button {
                settings.hasCompletedOnboarding = true
                onFinish()
            } label: {
                Text("Get Started")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .frame(width: 440, height: 560)
        .onAppear {
            calendar.refresh()
            focus.refresh()
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            PixelIcon(systemName: "rectangle.tophalf.inset.filled", size: 42,
                      tint: .accentColor)
            Text("Welcome to Notch")
                .font(.title2.weight(.semibold))
            Text("Media, agents, widgets, and a file shelf — all living in the notch. Grant what you'd like to use; everything can also be enabled later, in place.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

    private func permissionRow(
        symbol: String, title: String, subtitle: String,
        granted: Bool, request: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            PixelIcon(systemName: symbol, size: 18, tint: .accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body.weight(.medium))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if granted {
                PixelIcon(systemName: "checkmark.circle.fill", size: 18, tint: .green)
                    .accessibilityLabel("\(title) access granted")
            } else {
                Button("Enable", action: request)
                    .controlSize(.small)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 10))
    }

    private func toggleLabel(symbol: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            PixelIcon(systemName: symbol, size: 16, tint: .accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body.weight(.medium))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var agentsEnabledBinding: Binding<Bool> {
        Binding(
            get: { settings.agentsEnabled },
            set: { agents.setWatchingEnabled($0) }
        )
    }
}
