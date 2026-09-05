import SwiftUI

/// Polls Accessibility trust state so the flow completes live, without a
/// relaunch, the moment the user flips the toggle in System Settings.
@MainActor
final class PermissionWatcher: ObservableObject {
    @Published var granted: Bool

    private var poll: Task<Void, Never>?

    init() {
        granted = Permissions.hasAccessibility
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self else { return }
                let now = Permissions.hasAccessibility
                if now != self.granted {
                    self.granted = now
                }
            }
        }
    }

    deinit { poll?.cancel() }
}

struct OnboardingView: View {
    @StateObject private var watcher = PermissionWatcher()
    let onGranted: () -> Void

    var body: some View {
        VStack(spacing: Theme.Metrics.grid * 3) {
            Image(systemName: "command.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(Theme.Colors.accent)

            VStack(spacing: Theme.Metrics.grid) {
                Text("Allow Starboard to watch your keyboard")
                    .font(.system(size: 15, weight: .semibold))
                Text(
                    "Starboard needs Accessibility permission to detect the Right ⌘ key "
                        + "and switch apps instantly. Your keystrokes never leave this Mac."
                )
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, Theme.Metrics.grid * 4)

            Button("Open System Settings") {
                // The request is what registers Starboard in the Accessibility
                // list; without it the pane can open with nothing to enable.
                _ = Permissions.requestAccessibility()
                Self.openAccessibilitySettings()
            }
            .keyboardShortcut(.defaultAction)

            HStack(spacing: Theme.Metrics.grid) {
                ProgressView()
                    .controlSize(.small)
                Text(watcher.granted ? "Permission granted — starting…" : "Waiting for permission…")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            if watcher.granted {
                Text("You're all set")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Colors.accent)
            }
        }
        .padding(Theme.Metrics.grid * 4)
        .frame(width: 460, height: 300)
        .background(Theme.Colors.surface)
        .themeAccessibility()
        .onChange(of: watcher.granted) { _, granted in
            if granted {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { onGranted() }
            }
        }
    }

    static func openAccessibilitySettings() {
        if let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        ) {
            NSWorkspace.shared.open(url)
        }
    }
}
