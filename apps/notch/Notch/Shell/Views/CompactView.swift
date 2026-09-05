import AppKit
import NotchCore
import SwiftUI

/// The compact pill content hugging the bezel: a leading slot, the physical
/// notch gap, and a trailing slot. The host already draws the black blob, so
/// this view stays white-on-clear and never adds glass.
///
/// Idle is cheap on purpose. The audio meter is fed by real capture samples only
/// while this compact media surface is visible and playing; everything else is
/// data-driven and one-shot. No render loop and no `repeatForever`.
struct CompactView: View {
    let namespace: Namespace.ID

    @Environment(MediaManager.self) private var media
    @Environment(ActivityManager.self) private var activities
    @Environment(Settings.self) private var settings
    @Environment(AppEnvironment.self) private var env
    @Environment(TrayManager.self) private var tray

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.notchControlsSharedRendering) private var controlsSharedRendering
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// One-shot attention pop on a new event. Applied to each slot's content (not
    /// the full-width pill) so the icon/label scale about their own centers and
    /// stay put — scaling the whole pill pushed the leading icon under the corner.
    private func popping(_ view: some View) -> some View {
        view.phaseAnimator([0, 1, 2], trigger: activities.lastEventID) { content, phase in
            content.scaleEffect(popScale(phase))
        } animation: { _ in
            reduceMotion ? .smooth(duration: 0.2) : NotchAnimation.pop
        }
    }

    @ViewBuilder
    private var content: some View {
        if showCompactMedia {
            pill(
                leading: artworkThumbnail,
                trailing: mediaTrailing
            )
        } else if let activity = activities.compactActivity {
            if case let .agent(count, _, _, status) = activity.kind {
                pill(
                    leading: agentLeading(status: status),
                    trailing: agentTrailing(count: count)
                )
            } else {
                pill(
                    leading: activityIcon(activity),
                    trailing: activityLabel(activity)
                )
            }
        } else if !tray.items.isEmpty {
            pill(
                leading: PixelIcon(systemName: "tray.full", size: 15, tint: .white),
                trailing: Text(tray.items.count == 1 ? "1 item" : "\(tray.items.count) items")
                    .font(.system(size: NotchLayout.compactLabelFontSize, weight: .medium))
                    .lineLimit(1)
            )
        } else {
            Color.clear
        }
    }

    // MARK: - Layout

    /// Two equal slots flanking the fixed center gap. The slots fill the blob
    /// (their width comes from the host frame, not a self-measured ideal) so the
    /// content tracks the blob as its width animates — it can never overflow the
    /// growing blob and clip against the rounded corners mid-transition. The
    /// horizontal padding tracks the blob's shoulder so the leading icon keeps a
    /// constant gap from the *visible* edge at every width, not just at rest.
    private func pill(
        leading: some View,
        trailing: some View
    ) -> some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                popping(leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Color.clear
                    .frame(width: notchSize.width)
                popping(trailing)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.horizontal, NotchLayout.compactOuterPadding(width: geo.size.width, notchWidth: notchSize.width))
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    // MARK: - Media slots

    private var showCompactMedia: Bool {
        settings.media.compactNowPlaying && !media.track.isEmpty
    }

    private var visualizerRequested: Bool {
        showCompactMedia
            && settings.media.audioVisualizer
            && media.track.isPlaying
            && env.renderingActive
    }

    @ViewBuilder
    private var mediaTrailing: some View {
        if settings.media.audioVisualizer {
            CompactAudioVisualizer(
                requested: visualizerRequested,
                controlsCapture: controlsSharedRendering
            )
        } else {
            // Keep the flanking slots symmetrical so album art never shifts the
            // physical notch off-centre when the meter is disabled.
            Color.clear.frame(width: 14, height: 12)
        }
    }

    private var artSize: CGFloat {
        max(18, min(26, notchSize.height - 10))
    }

    private var artworkThumbnail: some View {
        Group {
            if let artwork = media.artwork {
                Image(nsImage: artwork)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    Rectangle().fill(.white.opacity(0.12))
                    PixelIcon(
                        systemName: "music.note",
                        size: artSize * 0.55,
                        tint: .white.opacity(0.8)
                    )
                }
            }
        }
        .frame(width: artSize, height: artSize)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .matchedGeometryEffect(id: "artwork", in: namespace)
        .accessibilityLabel("Album art")
    }

    // MARK: - Agent slots

    /// One retro spinner for the aggregate state (regardless of session count)
    /// + the aggregate status ("Running"). Ease the tint between states so a
    /// status shift reads as a transition, not a hard cut.
    private func agentLeading(status: AgentStatus) -> some View {
        HStack(spacing: NotchLayout.agentStatusGap) {
            PixelWorkingIndicator(active: status.isBusy, tint: agentPixelTint(status))
                .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: agentPixelTint(status))
            Text(ActivityPresenter.agentCompactStatus(status))
                .font(.system(size: NotchLayout.compactLabelFontSize, weight: .medium))
                .lineLimit(1)
                .contentTransition(.opacity)
                .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: status)
        }
    }

    /// Bold count + a quiet monospaced unit, mirroring the reserved width in
    /// `NotchLayout.compactAgentSlotWidth`.
    private func agentTrailing(count: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: NotchLayout.agentCountGap) {
            Text("\(count)")
                .font(.system(size: NotchLayout.compactLabelFontSize, weight: .bold))
                .contentTransition(.numericText())
                .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: count)
            Text(count == 1 ? "session" : "sessions")
                .font(.system(size: NotchLayout.agentSessionsFontSize, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.55))
        }
        .lineLimit(1)
    }

    private func agentPixelTint(_ status: AgentStatus) -> Color {
        switch status {
        // Attention/finished share the canonical palette; busy sessions render
        // in the spinner's retro working green.
        case .needsAttention, .finished: ActivityPresenter.agentTint(status)
        default: ActivityPresenter.agentWorkingTint
        }
    }

    // MARK: - Activity slots

    private func activityIcon(_ activity: Activity) -> some View {
        PixelIcon(
            systemName: ActivityPresenter.symbol(for: activity.kind),
            size: 15,
            tint: .white
        )
    }

    @ViewBuilder
    private func activityLabel(_ activity: Activity) -> some View {
        // A running timer ticks once a second via a scoped TimelineView — it only
        // mounts while the compact pill is on-screen (collapsed/occluded panels
        // are ordered out), so idle stays a zero render loop. A paused timer is a
        // static value, so it skips the TimelineView entirely.
        if case let .timer(_, endsAt, pausedRemaining) = activity.kind {
            if let pausedRemaining {
                Text(pausedRemaining.clockString)
                    .font(.system(size: NotchLayout.compactLabelFontSize, weight: .medium))
                    .monospacedDigit()
                    .lineLimit(1)
                    .opacity(0.6)
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(max(0, endsAt.timeIntervalSince(context.date)).clockString)
                        .font(.system(size: NotchLayout.compactLabelFontSize, weight: .medium))
                        .monospacedDigit()
                        .lineLimit(1)
                }
            }
        } else {
            let label = ActivityPresenter.compactLabel(for: activity.kind)
            // The agent pill holds one width across states, so a status change
            // (tool -> running) can cross-fade the label in place instead of
            // hard-cutting. Keyed on the string, so it only animates on a change.
            Text(label)
                .font(.system(size: NotchLayout.compactLabelFontSize, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .contentTransition(.opacity)
                .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: label)
        }
    }

    private func popScale(_ phase: Int) -> CGFloat {
        guard !reduceMotion else { return 1 }
        return phase == 1 ? 1.06 : 1.0
    }
}

/// Keeps high-frequency audio-level observation at the smallest possible leaf.
/// Capture ownership still follows the primary display, but a 30 fps meter no
/// longer invalidates and rebuilds the full compact media layout.
private struct CompactAudioVisualizer: View {
    @Environment(AudioVisualizerManager.self) private var visualizer

    let requested: Bool
    let controlsCapture: Bool

    var body: some View {
        LiveAudioVisualizer(levels: visualizer.levels)
            .onChange(of: requested, initial: true) { _, active in
                if controlsCapture {
                    visualizer.setActive(active)
                }
            }
            .onChange(of: controlsCapture) { wasControlling, isControlling in
                if wasControlling {
                    visualizer.setActive(false)
                }
                if isControlling {
                    visualizer.setActive(requested)
                }
            }
            .onDisappear {
                if controlsCapture {
                    visualizer.setActive(false)
                }
            }
    }
}

/// Three real frequency bands (bass, mids, treble), quantized to whole-point
/// heights to preserve the retro pixel edge. The analyzer already applies a fast
/// attack and gentle release, so adding another animation here would only add lag.
private struct LiveAudioVisualizer: View {
    let levels: AudioLevels

    private let barCount = 3
    private let barWidth: CGFloat = 3
    private let maxHeight: CGFloat = 12

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0 ..< barCount, id: \.self) { index in
                Rectangle()
                    .fill(.white)
                    .frame(width: barWidth, height: height(for: level(at: index)))
            }
        }
        .frame(height: maxHeight, alignment: .bottom)
        .accessibilityHidden(true)
    }

    private func level(at index: Int) -> Float {
        switch index {
        case 0: levels.low
        case 1: levels.mid
        default: levels.high
        }
    }

    private func height(for level: Float) -> CGFloat {
        let clamped = min(1, max(0, CGFloat(level)))
        return 2 + round(clamped * 5) * 2
    }
}
