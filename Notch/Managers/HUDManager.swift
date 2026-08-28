import SwiftUI
import Combine

/// Listen-only HUD: observes media keys, reads the current value, and shows an
/// auto-dismissing overlay alongside the system HUD (overlay-only by design).
@MainActor
final class HUDManager: ObservableObject {

    @Published private(set) var isVisible = false
    @Published private(set) var kind: HUDKind = .volume
    @Published private(set) var value: Double = 0
    @Published private(set) var muted = false

    private let settings: Settings
    private let tap = SystemDefinedTap()
    private let audio: AudioHardware
    private let brightness = Brightness()
    private var dismissTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    private var hardwareStarted = false

    private let visibleDuration: TimeInterval = 1.6

    init(settings: Settings, audio: AudioHardware) {
        self.settings = settings
        self.audio = audio
    }

    func start() {
        settings.$showHUD
            .sink { [weak self] enabled in self?.setEnabled(enabled) }
            .store(in: &cancellables)
    }

    private func setEnabled(_ enabled: Bool) {
        // Start the hardware listeners + tap exactly once; the publisher fires on
        // subscribe and on every toggle, so guard against re-registering them.
        // Disabling is handled in handle() (the tap can't be torn down cleanly).
        guard enabled, !hardwareStarted else { return }
        hardwareStarted = true
        audio.onChange = { [weak self] volume, muted in self?.audioChanged(Double(volume), muted) }
        audio.start()
        tap.onKeyDown = { [weak self] key in self?.handle(key) }
        if !tap.start() {
            Log.hud.notice("Input Monitoring not yet granted; HUD keys inactive until granted")
        }
    }

    private func handle(_ key: SystemDefinedTap.MediaKey) {
        guard settings.showHUD else { return }
        switch key {
        case .volumeUp, .volumeDown, .mute:
            let snapshot = audio.snapshot()
            muted = snapshot.muted
            value = Double(snapshot.volume)
            kind = muted ? .mute : .volume
            show()
        case .brightnessUp, .brightnessDown:
            // On an external display (or a missing private symbol) the brightness
            // read fails; without a real value the HUD would render the last *volume*
            // level under a brightness glyph. Skip our overlay in that case and set
            // the current value now so there's no stale flash before the refined read.
            guard let level = brightness.current() else { return }
            kind = .brightness
            value = Double(level)
            show()
            // Brightness has no change listener; re-read just after the system applies
            // the key press to catch the post-change level.
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, let level = self.brightness.current() else { return }
                self.value = Double(level)
            }
        }
    }

    private func audioChanged(_ volume: Double, _ muted: Bool) {
        guard isVisible, kind != .brightness else { return }
        self.muted = muted
        self.value = volume
        self.kind = muted ? .mute : .volume
    }

    private func show() {
        withAnimation(.easeOut(duration: 0.2)) { isVisible = true }
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(self?.visibleDuration ?? 1.6))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.18)) { self?.isVisible = false }
        }
    }
}
