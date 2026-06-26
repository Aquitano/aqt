import SwiftUI
import AppKit

/// The compact pill content hugging the bezel: a leading slot, the physical
/// notch gap, and a trailing slot. The host already draws the black blob, so
/// this view stays white-on-clear and never adds glass.
///
/// Idle is cheap on purpose. The only motion is data-driven and one-shot:
/// the now-playing bars pulse via a `phaseAnimator(trigger:)` keyed off each
/// media snapshot, and a "pop" fires once per new activity. No render loop,
/// no `repeatForever`.
struct CompactView: View {
    let namespace: Namespace.ID

    @EnvironmentObject private var media: MediaManager
    @EnvironmentObject private var activities: ActivityManager

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .phaseAnimator([0, 1, 2], trigger: activities.lastEventID) { view, phase in
                view.scaleEffect(popScale(phase))
            } animation: { _ in
                reduceMotion ? .smooth(duration: 0.2) : NotchAnimation.pop
            }
    }

    @ViewBuilder
    private var content: some View {
        if !media.track.isEmpty {
            pill(
                leading: artworkThumbnail,
                trailing: NowPlayingIndicator(
                    isPlaying: media.track.isPlaying,
                    trigger: media.lastUpdate,
                    reduceMotion: reduceMotion
                )
            )
        } else if let activity = activities.compactActivity {
            pill(leading: activityIcon(activity), trailing: activityLabel(activity))
        } else {
            Color.clear
        }
    }

    // MARK: - Layout

    /// Equal-width slots on either side of a fixed center gap; the symmetric
    /// padding keeps that gap aligned with the centered physical notch.
    private func pill<Leading: View, Trailing: View>(
        leading: Leading,
        trailing: Trailing
    ) -> some View {
        HStack(spacing: 0) {
            leading
                .frame(maxWidth: .infinity, alignment: .leading)
            Color.clear
                .frame(width: notchSize.width)
            trailing
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, 14)
    }

    // MARK: - Media slots

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
                    Image(systemName: "music.note")
                        .font(.system(size: artSize * 0.5, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
        }
        .frame(width: artSize, height: artSize)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .matchedGeometryEffect(id: "artwork", in: namespace)
        .accessibilityLabel("Album art")
    }

    // MARK: - Activity slots

    private func activityIcon(_ activity: Activity) -> some View {
        Image(systemName: activity.compactSymbol)
            .font(.system(size: 13, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
    }

    private func activityLabel(_ activity: Activity) -> some View {
        Text(compactLabel(for: activity))
            .font(.system(size: 12, weight: .medium))
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private func compactLabel(for activity: Activity) -> String {
        switch activity.kind {
        case .nowPlaying:
            return ""
        case let .charging(percent, _, _):
            return "\(percent)%"
        case let .lowBattery(percent):
            return "\(percent)%"
        case .lowPowerMode:
            return "Low Power"
        case let .deviceConnected(name, _, battery):
            return battery.map { "\($0)%" } ?? name
        case let .audioRoute(name, _):
            return name
        case let .focus(name, _):
            return name ?? "Focus"
        case let .peek(title, _, _, _):
            return title
        case let .timer(name, _):
            return name
        }
    }

    private func popScale(_ phase: Int) -> CGFloat {
        guard !reduceMotion else { return 1 }
        return phase == 1 ? 1.06 : 1.0
    }
}

/// Tiny now-playing equalizer. Bars pulse only while playing, and only when a
/// new media snapshot arrives (`trigger`), so there is no perpetual animation.
private struct NowPlayingIndicator: View {
    let isPlaying: Bool
    let trigger: Date
    let reduceMotion: Bool

    private let barCount = 4
    private let barWidth: CGFloat = 2.5
    private let maxHeight: CGFloat = 12

    /// rest -> peak -> settle; ends calm so the resting frame looks intentional.
    private let phases: [Int] = [0, 1, 2]

    var body: some View {
        HStack(alignment: .bottom, spacing: 2.5) {
            ForEach(0..<barCount, id: \.self) { index in
                bar(index)
            }
        }
        .frame(height: maxHeight, alignment: .bottom)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func bar(_ index: Int) -> some View {
        let shape = Capsule(style: .continuous)
            .fill(.white)
            .frame(width: barWidth)

        if isPlaying && !reduceMotion {
            shape.phaseAnimator(phases, trigger: trigger) { view, phase in
                view.frame(height: height(bar: index, phase: phase))
            } animation: { _ in
                .easeInOut(duration: 0.22)
            }
        } else {
            shape.frame(height: maxHeight * 0.42)
        }
    }

    private func height(bar: Int, phase: Int) -> CGFloat {
        let pattern: [[CGFloat]] = [
            [0.45, 0.70, 0.50, 0.65],   // rest
            [1.00, 0.40, 0.90, 0.50],   // peak
            [0.60, 0.80, 0.45, 0.70],   // settle
        ]
        return maxHeight * pattern[phase][bar]
    }
}
