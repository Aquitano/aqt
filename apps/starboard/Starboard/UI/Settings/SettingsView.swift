import SwiftUI
import ServiceManagement
import UniformTypeIdentifiers

struct SettingsView: View {
    /// The store is @Observable; reading and mutating through it keeps this
    /// view live and persists on every change.
    private var model: SettingsStore.Model { SettingsStore.shared.model }

    /// Every control edits the store directly — no cached copy to go stale when
    /// an import replaces the whole model.
    private func setting<Value>(
        _ keyPath: WritableKeyPath<SettingsStore.Model, Value>
    ) -> Binding<Value> {
        Binding(
            get: { SettingsStore.shared.model[keyPath: keyPath] },
            set: { SettingsStore.shared.model[keyPath: keyPath] = $0 }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Starboard Settings")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
            }
            .padding(Theme.Metrics.grid * 3)
            .background(Theme.Colors.header)

            Divider().overlay(Theme.Colors.stroke)

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Metrics.grid * 4) {
                    generalSection
                    spacesSection
                    stagesSection
                    assignmentsSection
                    excludedAppsSection
                }
                .padding(Theme.Metrics.grid * 3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 560, height: 500)
        .background(Theme.Colors.surface)
        .themeAccessibility()
    }

    // MARK: - General

    private var generalSection: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 1.5) {
            Text("General")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Trigger key").font(.system(size: 13))
                    Text("The modifier key held to switch apps, cycle, and search.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Picker("", selection: setting(\.primaryModifier)) {
                    ForEach(PrimaryModifier.allCases) { modifier in
                        Text(modifier.displayName).tag(modifier)
                    }
                }
                .labelsHidden()
                .frame(width: 175)
            }
            .padding(.vertical, 2)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hold overlay delay").font(.system(size: 13))
                    Text("How long to hold the trigger key before the overlay appears.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Picker("", selection: setting(\.holdOverlayDelayMs)) {
                    Text("150 ms (Fast)").tag(150)
                    Text("200 ms").tag(200)
                    Text("250 ms").tag(250)
                    Text("300 ms (Default)").tag(300)
                    Text("400 ms").tag(400)
                    Text("500 ms (Relaxed)").tag(500)
                }
                .labelsHidden()
                .frame(width: 175)
            }
            .padding(.vertical, 2)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Repeat press").font(.system(size: 13))
                    Text(repeatPressDetail)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Picker("", selection: setting(\.repeatPress)) {
                    Text("Cycle windows").tag(RepeatPressAction.cycleWindows)
                    Text("Hide app").tag(RepeatPressAction.hide)
                    Text("Cycle apps").tag(RepeatPressAction.cycleApps)
                }
                .labelsHidden()
                .frame(width: 175)
            }
            .padding(.vertical, 2)

            ToggleRow(
                title: "Launch apps that aren't running",
                detail: "Pressing a letter with no running match launches the installed app.",
                isOn: setting(\.launchIfNotRunning)
            )

            ToggleRow(
                title: "Window jump with \(model.primaryModifier.secondaryShortName)",
                detail: "\(model.primaryModifier.secondaryShortName) + letter steps through that app's windows. Consumes \(model.primaryModifier.secondaryShortName) — leave off if you type special characters with it.",
                isOn: setting(\.windowJumpEnabled)
            )

            ToggleRow(
                title: "Mouse follows focused app",
                detail: "Warps the pointer to the focused window's center after a switch.",
                isOn: setting(\.mouseFollowsFocus)
            )

            LaunchAtLoginRow()
            ScreenRecordingRow()
            ExportImportRow()
        }
    }

    private var repeatPressDetail: String {
        switch model.repeatPress {
        case .cycleWindows:
            "Pressing a focused app's letter steps through its windows, most recent first."
        case .hide:
            "Pressing a focused app's letter hides it."
        case .cycleApps:
            "Pressing a focused app's letter cycles other apps on the same letter."
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
                Picker("", selection: setting(\.spacesStrategy)) {
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
                detail: "ralt+1…9 sends the focused window to that Space.",
                isOn: setting(\.spacesMoveWindowEnabled)
            )
            .disabled(!usesDirectEngine)

            ToggleRow(
                title: "Space number in menu bar",
                detail: "Shows the active Space.",
                isOn: setting(\.showSpaceNumber)
            )
            .disabled(!usesDirectEngine)

            if !usesDirectEngine {
                Text("Both need the Instant engine.")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var usesDirectEngine: Bool { model.spacesStrategy == .direct }

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
                Picker("", selection: setting(\.stagesTrigger)) {
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

            Text("Hold \(model.primaryModifier.shortName) + \(model.primaryModifier.secondaryShortName) and press a letter to pin the frontmost app to it.")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)

            if rows.isEmpty {
                Text("No running apps yet.")
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, Theme.Metrics.grid * 2)
            } else {
                ForEach(rows) { row in
                    AssignmentRow(
                        row: row,
                        onClear: { clear(row: row) },
                        onExclude: { exclude(row: row) }
                    )
                    .padding(.vertical, 4)
                    Divider().overlay(Theme.Colors.stroke)
                }
            }
        }
    }

    private func clear(row: AssignmentRowModel) {
        SettingsStore.shared.model.customAssignments[row.letter.lowercased()] = nil
    }

    private func exclude(row: AssignmentRowModel) {
        if !SettingsStore.shared.model.excludedBundleIDs.contains(row.bundleID) {
            SettingsStore.shared.model.excludedBundleIDs.append(row.bundleID)
        }
        SettingsStore.shared.model.customAssignments[String(row.letter).lowercased()] = nil
    }

    private var rows: [AssignmentRowModel] {
        var seen = Set<Character>()
        var result: [AssignmentRowModel] = []
        let excludedIDs = model.excludedBundleIDSet

        for (key, bundleID) in model.customAssignments.sorted(by: { $0.key < $1.key }) {
            guard let letter = key.lowercased().first else { continue }
            let name = AppIcons.name(for: bundleID) ?? "Not installed"
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
                  !excludedIDs.contains(id),
                  let letter = LetterAssigner.dynamicLetter(for: name),
                  seen.insert(letter).inserted else { continue }
            result.append(AssignmentRowModel(letter: letter, name: name, bundleID: id, custom: false))
        }

        return result.sorted {
            if $0.custom != $1.custom { return $0.custom }
            return $0.letter < $1.letter
        }
    }

    // MARK: - Excluded Apps

    private var excludedAppsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 1.5) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Excluded Apps")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("Excluded apps will not be assigned letters or appear in search and window cycling.")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Button("Exclude App…", action: pickAppToExclude)
                    .controlSize(.small)
            }

            if model.excludedBundleIDs.isEmpty {
                Text("No apps excluded.")
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, Theme.Metrics.grid)
            } else {
                ForEach(model.excludedBundleIDs, id: \.self) { bundleID in
                    HStack(spacing: Theme.Metrics.grid * 1.5) {
                        if let icon = AppIcons.icon(for: bundleID) {
                            Image(nsImage: icon)
                                .resizable()
                                .frame(width: 20, height: 20)
                        } else {
                            Image(systemName: "app.dashed")
                                .frame(width: 20, height: 20)
                                .foregroundStyle(.secondary)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(AppIcons.name(for: bundleID) ?? bundleID)
                                .font(.system(size: 13))
                                .lineLimit(1)
                            Text(bundleID)
                                .font(.system(size: 10))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                        Spacer()
                        Button("Remove") {
                            SettingsStore.shared.model.excludedBundleIDs.removeAll { $0 == bundleID }
                        }
                        .controlSize(.small)
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.Colors.destructive)
                    }
                    .padding(.vertical, 4)
                    Divider().overlay(Theme.Colors.stroke)
                }
            }
        }
    }

    private func pickAppToExclude() {
        let panel = NSOpenPanel()
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            guard let bundle = Bundle(url: url), let bundleID = bundle.bundleIdentifier else { continue }
            if !SettingsStore.shared.model.excludedBundleIDs.contains(bundleID) {
                SettingsStore.shared.model.excludedBundleIDs.append(bundleID)
            }
        }
    }
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
                    if let icon = AppIcons.icon(for: app.bundleID) {
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
                        Text(AppIcons.name(for: app.bundleID) ?? app.bundleID)
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
}

struct AssignmentRowModel: Identifiable {
    let letter: Character
    let name: String
    let bundleID: String
    let custom: Bool

    var id: String { "\(letter)-\(bundleID)" }

    @MainActor
    var icon: NSImage? { AppIcons.icon(for: bundleID) }
}

struct AssignmentRow: View {
    let row: AssignmentRowModel
    let onClear: () -> Void
    var onExclude: (() -> Void)? = nil

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
            if let onExclude {
                Button("Exclude", action: onExclude)
                    .controlSize(.small)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }
}

struct ToggleRow: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool

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
    /// The request only returns true for a grant made in an earlier run: a
    /// fresh grant takes effect on the next launch.
    @State private var asked = false

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Window titles").font(.system(size: 13))
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if !granted {
                Button("Grant…") {
                    granted = Permissions.requestScreenRecording()
                    asked = !granted
                }
                .controlSize(.small)
            }
        }
        .padding(.vertical, 2)
    }

    private var detail: String {
        if granted {
            return "Screen Recording granted — window search shows real titles."
        }
        if asked {
            return "Relaunch Starboard after granting Screen Recording for titles to appear."
        }
        return "Needs the Screen Recording permission. Starboard never records your screen."
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
