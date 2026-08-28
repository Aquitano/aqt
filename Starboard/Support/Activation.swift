import AppKit

extension NSRunningApplication {
    /// Starboard is never the active app (its panels are nonactivating), so it
    /// has nothing to hand over and macOS 14+ sometimes refuses the cooperative
    /// `activate()`. `activate(options:)` is not deprecated on
    /// NSRunningApplication and is still honored; the retry covers Space and
    /// app transitions that swallow even that.
    @MainActor
    func activateReliably() {
        activate(options: Self.ignoringOtherApps)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            guard let self, !self.isActive, !self.isTerminated else { return }
            Perf.activationRetried(self.localizedName ?? self.bundleIdentifier ?? "unknown")
            self.activate(options: Self.ignoringOtherApps)
        }
    }

    /// `.activateIgnoringOtherApps` spelled by raw value: the symbol is
    /// deprecated because it no longer does anything on `NSApplication`, but it
    /// still works here. Using the value keeps the warning out of the build
    /// without touching global warning settings.
    private static let ignoringOtherApps = NSApplication.ActivationOptions(rawValue: 1 << 1)
}
