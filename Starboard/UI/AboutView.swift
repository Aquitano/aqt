import SwiftUI

struct AboutView: View {
    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    private var build: String {
        Bundle.main.object(forInfoDictionaryKey: kCFBundleVersionKey as String) as? String ?? "—"
    }

    private var copyright: String {
        Bundle.main.object(forInfoDictionaryKey: "NSHumanReadableCopyright") as? String ?? ""
    }

    var body: some View {
        VStack(spacing: Theme.Metrics.grid * 1.5) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            Text("Starboard")
                .font(.system(size: 22, weight: .semibold))
            Text("Version \(version) (\(build))")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("Fast, keyboard-first navigation for macOS.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            if !copyright.isEmpty {
                Text(copyright)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .padding(.top, Theme.Metrics.grid)
            }
        }
        .padding(Theme.Metrics.grid * 4)
        .frame(width: 360, height: 280)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.surface)
        .themeAccessibility()
    }
}
