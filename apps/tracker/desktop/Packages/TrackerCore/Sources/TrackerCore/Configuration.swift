import Foundation

package struct TrackerConfiguration: Sendable, Equatable {
    /// The extension already records everything that happens inside a Chromium
    /// browser, so the desktop agent stays silent while one is frontmost.
    package static let defaultSkipBundleIDs: Set<String> = [
        "com.google.chrome",
        "com.google.chrome.canary",
        "com.google.chrome.beta",
        "org.chromium.chromium",
        "com.brave.browser",
        "com.microsoft.edgemac",
        "company.thebrowser.browser",
        "com.vivaldi.vivaldi",
    ]

    package static let defaultPrivateBundleIDs: Set<String> = [
        "com.1password.1password",
        "com.apple.keychainaccess",
        "com.apple.passwords",
    ]

    package static let defaultServerURL = URL(string: "http://127.0.0.1:8490")!

    /// Where `tracker login` leaves its session, which is Go's
    /// `os.UserConfigDir()` on macOS. Sharing the file is what lets the
    /// agent sign in once, at a terminal, and stay signed in.
    package static var defaultTokenPath: String? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appending(path: "tracker/token.json").path(percentEncoded: false)
    }

    package var serverURL: URL
    package var tokenPath: String?
    package var skipBundleIDs: Set<String>
    package var privateBundleIDs: Set<String>

    package init(
        serverURL: URL = TrackerConfiguration.defaultServerURL,
        tokenPath: String? = nil,
        skipBundleIDs: Set<String> = TrackerConfiguration.defaultSkipBundleIDs,
        privateBundleIDs: Set<String> = TrackerConfiguration.defaultPrivateBundleIDs
    ) {
        self.serverURL = serverURL
        self.tokenPath = tokenPath
        self.skipBundleIDs = Set(skipBundleIDs.map { $0.lowercased() })
        self.privateBundleIDs = Set(privateBundleIDs.map { $0.lowercased() })
    }

    package static func environment(
        _ values: [String: String] = ProcessInfo.processInfo.environment
    ) -> TrackerConfiguration {
        TrackerConfiguration(
            serverURL: values["TRACKER_SERVER_URL"].flatMap { URL(string: $0) } ?? defaultServerURL,
            tokenPath: tokenPath(values["TRACKER_TOKEN_PATH"]),
            skipBundleIDs: list(values["TRACKER_SKIP_BUNDLE_IDS"]) ?? defaultSkipBundleIDs,
            privateBundleIDs: list(values["TRACKER_PRIVATE_BUNDLE_IDS"]) ?? defaultPrivateBundleIDs
        )
    }

    package func isSkipped(_ bundleID: String) -> Bool {
        skipBundleIDs.contains(bundleID.lowercased())
    }

    package func isPrivate(_ bundleID: String) -> Bool {
        privateBundleIDs.contains(bundleID.lowercased())
    }

    /// An empty variable means "no token", which is how authentication is
    /// turned off; an unset variable keeps the default location.
    package static func tokenPath(_ raw: String?) -> String? {
        guard let raw else { return defaultTokenPath }
        return raw.isEmpty ? nil : raw
    }

    /// An empty variable means "no entries", which is how the skip list is
    /// turned off; an unset variable keeps the default.
    private static func list(_ raw: String?) -> Set<String>? {
        guard let raw else { return nil }
        return Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }
}
