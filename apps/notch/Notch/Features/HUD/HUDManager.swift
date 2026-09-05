import ApplicationServices
import NotchCore
import SwiftUI

/// Volume/brightness HUD in two tiers. Listen-only observes media keys and
/// shows the overlay alongside the system HUD. With "Replace the system HUD"
/// on (and Accessibility granted) the tap consumes the keys, this manager
/// applies the change itself, and the native HUD never appears. A key the
/// hardware can't honour (external-display brightness, an unwritable device)
/// is passed back to the system — never swallowed into a no-op.
@MainActor
@Observable
final class HUDManager {
    private(set) var isVisible = false
    private(set) var kind: HUDKind = .volume
    private(set) var value: Double = 0
    private(set) var muted = false
    /// True while the consuming tap is active (we own the keys and the HUD).
    private(set) var replacingSystemHUD = false

    private let settings: Settings
    private let tap = SystemDefinedTap()
    private let audio: AudioHardware
    private let brightness = Brightness()
    private var dismissTask: Task<Void, Never>?
    private var trustRetryTask: Task<Void, Never>?
    private var settingsObserver: Task<Void, Never>?
    private var hardwareStarted = false

    private let visibleDuration: TimeInterval = 1.6
    /// Coarse step matches the system's 16 segments; fine is Shift+Option.
    private let coarseStep: Float = 1 / 16
    private let fineStep: Float = 1 / 64

    init(settings: Settings, audio: AudioHardware) {
        self.settings = settings
        self.audio = audio
    }

    func start() {
        tap.onMediaKey = { [weak self] key, fine in
            // The tap delivers on the main run loop, so hopping into the actor
            // is safe and keeps the swallow decision synchronous.
            MainActor.assumeIsolated { self?.handle(key, fine: fine) ?? false }
        }
        settingsObserver = watch({ [settings] in
            (settings.hud.enabled, settings.hud.replacesSystem) })
        { [weak self] show, replace in
            self?.configure(show: show, replace: replace)
        }
    }

    private func configure(show: Bool, replace: Bool) {
        trustRetryTask?.cancel()
        trustRetryTask = nil
        guard show else {
            tap.stop()
            replacingSystemHUD = false
            return
        }
        startHardwareIfNeeded()

        let trusted = AXIsProcessTrusted()
        let consuming = replace && trusted
        let started = tap.start(consuming: consuming)
        replacingSystemHUD = started && consuming
        if !started {
            Log.hud.notice("Media-key access not yet granted; HUD keys inactive until granted")
        }
        // Accessibility can be granted while we're running with no notification;
        // poll gently until it lands so the toggle takes effect without a restart.
        if replace, !trusted {
            trustRetryTask = Task { [weak self] in
                while !Task.isCancelled, !AXIsProcessTrusted() {
                    try? await Task.sleep(for: .seconds(3))
                }
                guard !Task.isCancelled, let self else { return }
                self.configure(show: self.settings.hud.enabled, replace: self.settings.hud.replacesSystem)
            }
        }
    }

    private func startHardwareIfNeeded() {
        guard !hardwareStarted else { return }
        hardwareStarted = true
        audio.onChange = { [weak self] volume, muted in self?.audioChanged(Double(volume), muted) }
        audio.start()
    }

    /// Returns true when the key was fully handled here and must be swallowed.
    private func handle(_ key: SystemDefinedTap.MediaKey, fine: Bool) -> Bool {
        guard settings.hud.enabled else { return false }
        let step = fine ? fineStep : coarseStep

        switch key {
        case .volumeUp, .volumeDown:
            if replacingSystemHUD,
               let result = audio.applyVolumeStep(key == .volumeUp ? step : -step)
            {
                present(volume: Double(result.volume), muted: result.muted)
                return true
            }
            presentVolumeSnapshot()
            return false

        case .mute:
            if replacingSystemHUD, let result = audio.toggleMute() {
                present(volume: Double(result.volume), muted: result.muted)
                return true
            }
            presentVolumeSnapshot()
            return false

        case .brightnessUp, .brightnessDown:
            if replacingSystemHUD,
               let level = brightness.applyStep(key == .brightnessUp ? step : -step)
            {
                kind = .brightness
                value = Double(level)
                show()
                return true
            }
            // Listen-only (and the consuming fallback when the write fails): on
            // an external display the brightness read fails too; without a real
            // value the HUD would render the last *volume* level under a
            // brightness glyph, so skip our overlay entirely.
            guard let level = brightness.current() else { return false }
            kind = .brightness
            value = Double(level)
            show()
            // Brightness has no change listener; re-read just after the system
            // applies the key press to catch the post-change level.
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, let level = self.brightness.current() else { return }
                self.value = Double(level)
            }
            return false
        }
    }

    private func presentVolumeSnapshot() {
        let snapshot = audio.snapshot()
        present(volume: Double(snapshot.volume), muted: snapshot.muted)
    }

    private func present(volume: Double, muted: Bool) {
        self.muted = muted
        value = volume
        kind = muted ? .mute : .volume
        show()
    }

    private func audioChanged(_ volume: Double, _ muted: Bool) {
        guard isVisible, kind != .brightness else { return }
        present(volume: volume, muted: muted)
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
