import ApplicationServices
import SwiftUI

/// Asks for the Accessibility permission and calls `onGranted` as soon as
/// System Settings grants it, without a relaunch.
struct OnboardingView: View {
    let onGranted: () -> Void

    private static let accessibilityPane = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    )

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
                // The prompt is what lists Starboard in the Accessibility
                // pane; without it the pane has nothing to turn on.
                AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
                if let pane = Self.accessibilityPane {
                    NSWorkspace.shared.open(pane)
                }
            }
            .keyboardShortcut(.defaultAction)

            HStack(spacing: Theme.Metrics.grid) {
                ProgressView()
                    .controlSize(.small)
                Text("Waiting for permission…")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(Theme.Metrics.grid * 4)
        .frame(width: 460, height: 300)
        .background(Theme.Colors.surface)
        .task {
            while !AXIsProcessTrusted() {
                guard await (try? Task.sleep(for: .milliseconds(500))) != nil else { return }
            }
            onGranted()
        }
    }
}
