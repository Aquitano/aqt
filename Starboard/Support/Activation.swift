import AppKit

extension NSRunningApplication {
    /// Cooperative activation can occasionally be refused while Spaces or
    /// another app is transitioning. Retry once after that transition settles.
    @MainActor
    func activateReliably() {
        activate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            guard let self, !self.isActive, !self.isTerminated else { return }
            self.activate()
        }
    }
}
