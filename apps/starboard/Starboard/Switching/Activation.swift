import AppKit

/// Counts activation requests so only the newest one retries.
@MainActor private var latestActivation = 0

extension NSRunningApplication {
    /// Starboard is never the active app, so it has nothing to hand over, and
    /// macOS 14 and later sometimes refuse the cooperative `activate()`.
    /// `activate(options:)` is still honored; the retry covers Space and app
    /// transitions that swallow even that.
    ///
    /// Without the generation check, switching to Safari and then to Mail
    /// within the retry delay would let Safari take focus back.
    @MainActor
    func activateReliably() {
        latestActivation += 1
        let generation = latestActivation
        activate(options: Self.ignoringOtherApps)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            MainActor.assumeIsolated {
                guard generation == latestActivation, let self, !self.isActive, !self.isTerminated else { return }
                signposter.emitEvent("Activation retry")
                let name = self.localizedName ?? self.bundleIdentifier ?? "unknown"
                log.info("Activation retry: \(name, privacy: .public)")
                self.activate(options: Self.ignoringOtherApps)
            }
        }
    }

    /// `.activateIgnoringOtherApps` by raw value. The symbol is deprecated
    /// because it does nothing on `NSApplication`, but it still works here.
    private static let ignoringOtherApps = NSApplication.ActivationOptions(rawValue: 1 << 1)
}
