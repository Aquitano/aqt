import SwiftUI
import ServiceManagement

struct SettingsView: View {
    /// The store is @Observable; reading and mutating through it keeps this
    /// view live and persists on every change.
    private var model: SettingsStore.Model { SettingsStore.shared.model }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Starboard Settings")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
            }
            .padding(Theme.Metrics.grid * 3)
            .background(headerBackground)

            Divider().overlay(Theme.Colors.stroke)

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Metrics.grid * 4) {
                    generalSection
                    assignmentsSection
                }
                .padding(Theme.Metrics.grid * 3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 560, height: 480)
        .background(background)
        .preferredColorScheme(.dark)
    }

    // MARK: - General

    private var generalSection: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 1.5) {
            Text("General")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            ToggleRow(
                title: "Hide app on repeat press",
                detail: "Pressing an already-focused app's letter hides it.",
                initial: model.hideOnRepeat
            ) { SettingsStore.shared.model.hideOnRepeat.toggle() }

            ToggleRow(
                title: "Launch apps that aren't running",
                detail: "Pressing a letter with no running match launches the installed app.",
                initial: model.launchIfNotRunning
            ) { SettingsStore.shared.model.launchIfNotRunning.toggle() }

            LaunchAtLoginRow()
        }
    }

    // MARK: - Assignments

    private var assignmentsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 1.5) {
            Text("Assignments")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            if rows.isEmpty {
                Text("No running apps yet.")
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, Theme.Metrics.grid * 2)
            } else {
                ForEach(rows) { row in
                    AssignmentRow(row: row) { clear(row: row) }
                        .padding(.vertical, 4)
                    Divider().overlay(Theme.Colors.stroke)
                }
            }
        }
    }

    private func clear(row: AssignmentRowModel) {
        SettingsStore.shared.model.customAssignments[row.letter.lowercased()] = nil
    }

    private var rows: [AssignmentRowModel] {
        var seen = Set<Character>()
        var result: [AssignmentRowModel] = []

        for (key, bundleID) in model.customAssignments.sorted(by: { $0.key < $1.key }) {
            guard let letter = key.lowercased().first else { continue }
            let name = Self.appName(for: bundleID) ?? "Not installed"
            result.append(AssignmentRowModel(letter: letter, name: name, bundleID: bundleID, custom: true))
            seen.insert(letter)
        }

        let pinnedIDs = Set(model.customAssignments.values)
        let running = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && !$0.isTerminated
        }
        for app in running {
            guard let id = app.bundleIdentifier,
                  let name = app.localizedName,
                  !pinnedIDs.contains(id),
                  let letter = LetterAssigner.dynamicLetter(for: name),
                  seen.insert(letter).inserted else { continue }
            result.append(AssignmentRowModel(letter: letter, name: name, bundleID: id, custom: false))
        }

        return result.sorted {
            if $0.custom != $1.custom { return $0.custom }
            return $0.letter < $1.letter
        }
    }

    private static func appName(for bundleID: String) -> String? {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first {
            return app.localizedName
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
              let bundle = Bundle(url: url) else { return nil }
        return bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
    }

    // MARK: - Chrome

    private var background: Color {
        colorScheme == .dark ? Theme.Colors.surface : Color(red: 0.96, green: 0.96, blue: 0.97)
    }

    private var headerBackground: Color {
        colorScheme == .dark ? Color.white.opacity(0.04) : Color.black.opacity(0.03)
    }

    @Environment(\.colorScheme) private var colorScheme
}

// MARK: - Row models & views

struct AssignmentRowModel: Identifiable {
    let letter: Character
    let name: String
    let bundleID: String
    let custom: Bool

    var id: String { "\(letter)-\(bundleID)" }

    var icon: NSImage? {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}

struct AssignmentRow: View {
    let row: AssignmentRowModel
    let onClear: () -> Void

    var body: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            KeyCap(character: row.letter)
            if let icon = row.icon {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 20, height: 20)
            }
            Text(row.name)
                .font(.system(size: 13))
                .lineLimit(1)
            if row.custom {
                Text("CUSTOM")
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(0.5)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Theme.Colors.accent.opacity(0.16)))
                    .foregroundStyle(Theme.Colors.accent)
            }
            Spacer()
            if row.custom {
                Button("Clear", action: onClear)
                    .controlSize(.small)
                    .buttonStyle(.borderless)
            }
        }
        .contentShape(Rectangle())
    }
}

struct ToggleRow: View {
    let title: String
    let detail: String
    let onToggle: () -> Void

    @State private var isOn: Bool

    init(title: String, detail: String, initial: Bool = true, onToggle: @escaping () -> Void) {
        self.title = title
        self.detail = detail
        self.onToggle = onToggle
        _isOn = State(initialValue: initial)
    }

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13))
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("", isOn: $isOn)
                .toggleStyle(.switch)
                .labelsHidden()
                .onChange(of: isOn) { _, _ in onToggle() }
        }
        .padding(.vertical, 2)
    }
}

/// Reflects and drives SMAppService login-item registration.
struct LaunchAtLoginRow: View {
    @State private var isEnabled = SMAppService.mainApp.status == .enabled
    @State private var errorText: String?

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Launch at login").font(.system(size: 13))
                if let errorText {
                    Text(errorText)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.Colors.destructive)
                }
            }
            Spacer()
            Toggle("", isOn: $isEnabled)
                .toggleStyle(.switch)
                .labelsHidden()
                .onChange(of: isEnabled) { _, enabled in set(enabled) }
        }
        .padding(.vertical, 2)
    }

    private func set(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            errorText = nil
        } catch {
            errorText = "Failed: \(error.localizedDescription)"
            isEnabled = SMAppService.mainApp.status == .enabled
        }
    }
}
