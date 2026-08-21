import SwiftUI
import ServiceManagement
import UniformTypeIdentifiers

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
                    spacesSection
                    stagesSection
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

            ToggleRow(
                title: "Window jump with Right ⌥",
                detail: "ralt+letter steps through that app's windows. Consumes Right Option — leave off if you type special characters with it.",
                initial: model.windowJumpEnabled
            ) { SettingsStore.shared.model.windowJumpEnabled.toggle() }

            ToggleRow(
                title: "Key hints",
                detail: "Hold rcmd for a moment to see which letter focuses which app.",
                initial: model.showKeyHints
            ) { SettingsStore.shared.model.showKeyHints.toggle() }

            ToggleRow(
                title: "Mouse follows focused app",
                detail: "Warps the pointer to the focused window's center after a switch.",
                initial: model.mouseFollowsFocus
            ) { SettingsStore.shared.model.mouseFollowsFocus.toggle() }

            LaunchAtLoginRow()
            ScreenRecordingRow()
            ExportImportRow()
        }
    }

    // MARK: - Spaces

    private var spacesSection: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 1.5) {
            Text("Spaces")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Switching engine").font(.system(size: 13))
                    Text(
                        model.spacesStrategy == .synthetic
                            ? "Posts Mission Control shortcuts. Enable ctrl+1…9 under System Settings → Keyboard → Shortcuts → Mission Control."
                            : "Instant, animation-free switching via private APIs. Falls back to Compatible if unavailable on this macOS."
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Picker("", selection: Binding(
                    get: { SettingsStore.shared.model.spacesStrategy },
                    set: { SettingsStore.shared.model.spacesStrategy = $0 }
                )) {
                    Text("Compatible").tag(SpacesStrategy.synthetic)
                    Text("Instant").tag(SpacesStrategy.direct)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 190)
            }
            .padding(.vertical, 2)

            ToggleRow(
                title: "Move windows with Right ⌥",
                detail: "ralt+1…9 sends the focused window to that Space. Needs the Instant engine.",
                initial: model.spacesMoveWindowEnabled
            ) { SettingsStore.shared.model.spacesMoveWindowEnabled.toggle() }

            ToggleRow(
                title: "Space number in menu bar",
                detail: "Shows the active Space. Needs the Instant engine.",
                initial: model.showSpaceNumber
            ) { SettingsStore.shared.model.showSpaceNumber.toggle() }
        }
    }

    // MARK: - Stages

    private var stagesSection: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 1.5) {
            Text("Stages")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Leader key").font(.system(size: 13))
                    Text("Tap it, then a letter restores a Stage, = saves one, – closes the active one.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Picker("", selection: Binding(
                    get: { SettingsStore.shared.model.stagesTrigger },
                    set: { SettingsStore.shared.model.stagesTrigger = $0 }
                )) {
                    Text("Caps Lock").tag(StagesTrigger.capsLock)
                    Text("Right ⇧ tap").tag(StagesTrigger.rightShift)
                    Text("Off").tag(StagesTrigger.off)
                }
                .labelsHidden()
                .frame(width: 130)
            }
            .padding(.vertical, 2)

            if model.stages.isEmpty {
                Text("No Stages yet — press the leader key, then = to save the current workspace.")
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, Theme.Metrics.grid)
            } else {
                ForEach(model.stages) { stage in
                    StageRow(stage: stage) {
                        SettingsStore.shared.model.stages.removeAll { $0.id == stage.id }
                    }
                    .padding(.vertical, 4)
                    Divider().overlay(Theme.Colors.stroke)
                }
            }
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

/// One saved Stage: letter chip, editable open-items, delete.
struct StageRow: View {
    let stage: Stage
    let onDelete: () -> Void

    @State private var showingItems = false

    var body: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            if let letter = stage.letter.first {
                KeyCap(character: letter)
            }
            Text(stage.name)
                .font(.system(size: 13))
                .lineLimit(1)
            HStack(spacing: 4) {
                ForEach(stage.apps, id: \.bundleID) { app in
                    if let icon = StageSaveView.icon(for: app.bundleID) {
                        Image(nsImage: icon)
                            .resizable()
                            .frame(width: 16, height: 16)
                    }
                }
            }
            Spacer()
            Button("Items…") { showingItems = true }
                .controlSize(.small)
                .buttonStyle(.borderless)
                .popover(isPresented: $showingItems) {
                    StageItemsEditor(stageID: stage.id)
                }
            Button("Delete", action: onDelete)
                .controlSize(.small)
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.Colors.destructive)
        }
        .contentShape(Rectangle())
    }
}

/// Per-Stage open-items editor: one file path or URL per line, per app.
struct StageItemsEditor: View {
    let stageID: UUID

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 1.5) {
            Text("Opened on restore")
                .font(.system(size: 13, weight: .semibold))
            Text("One file path or URL per line, per app.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)

            if let stage = SettingsStore.shared.model.stages.first(where: { $0.id == stageID }) {
                ForEach(Array(stage.apps.enumerated()), id: \.element.bundleID) { index, app in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(appName(app.bundleID))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                        TextEditor(text: itemsBinding(appIndex: index))
                            .font(.system(size: 12).monospaced())
                            .frame(height: 48)
                            .scrollContentBackground(.hidden)
                            .padding(4)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color.primary.opacity(0.06))
                            )
                    }
                }
            }
        }
        .padding(Theme.Metrics.grid * 2)
        .frame(width: 320)
    }

    private func itemsBinding(appIndex: Int) -> Binding<String> {
        Binding(
            get: {
                guard let stage = SettingsStore.shared.model.stages.first(where: { $0.id == stageID }),
                      stage.apps.indices.contains(appIndex) else { return "" }
                return stage.apps[appIndex].openItems.joined(separator: "\n")
            },
            set: { text in
                guard let stageIndex = SettingsStore.shared.model.stages.firstIndex(where: { $0.id == stageID }),
                      SettingsStore.shared.model.stages[stageIndex].apps.indices.contains(appIndex)
                else { return }
                SettingsStore.shared.model.stages[stageIndex].apps[appIndex].openItems = text
                    .split(separator: "\n")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
            }
        )
    }

    private func appName(_ bundleID: String) -> String {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
              let bundle = Bundle(url: url),
              let name = bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
        else { return bundleID }
        return name
    }
}

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

/// Settings backup as pretty-printed JSON.
struct ExportImportRow: View {
    @State private var status: String?

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Backup").font(.system(size: 13))
                Text(status ?? "Export or import all settings, assignments, and Stages as JSON.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Export…", action: exportSettings).controlSize(.small)
            Button("Import…", action: importSettings).controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private func exportSettings() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "starboard-settings.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try SettingsStore.shared.exportJSON().write(to: url)
            status = "Exported to \(url.lastPathComponent)."
        } catch {
            status = "Export failed: \(error.localizedDescription)"
        }
    }

    private func importSettings() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try SettingsStore.shared.importJSON(Data(contentsOf: url))
            status = "Imported \(url.lastPathComponent)."
        } catch {
            status = "Import failed: \(error.localizedDescription)"
        }
    }
}

/// Screen Recording is optional: without it window search shows "App Window"
/// instead of real titles. Starboard never captures the screen.
struct ScreenRecordingRow: View {
    @State private var granted = Permissions.hasScreenRecording

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Window titles").font(.system(size: 13))
                Text(
                    granted
                        ? "Screen Recording granted — window search shows real titles."
                        : "Needs the Screen Recording permission. Starboard never records your screen."
                )
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            }
            Spacer()
            if !granted {
                Button("Grant…") {
                    granted = Permissions.requestScreenRecording()
                }
                .controlSize(.small)
            }
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
