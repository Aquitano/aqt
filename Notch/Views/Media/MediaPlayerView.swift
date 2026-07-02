import SwiftUI
import AppKit

/// Expanded now-playing surface: large album art that glides in from the compact
/// pill via `matchedGeometryEffect(id: "artwork")`, title/artist, transport, and a
/// scrubbable seek bar. The seek bar only mounts a periodic render loop while the
/// track is actually playing; paused or non-seekable tracks cost nothing.
struct MediaPlayerView: View {
    let namespace: Namespace.ID

    @EnvironmentObject private var media: MediaManager

    var body: some View {
        HStack(spacing: 16) {
            artwork

            VStack(alignment: .leading, spacing: 8) {
                info
                Spacer(minLength: 0)
                transport
                if media.canSeek {
                    SeekBar(
                        duration: media.track.duration,
                        isPlaying: media.track.isPlaying,
                        position: { media.position(asOf: $0) },
                        onScrub: { media.send(.seek($0)) }
                    )
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
    }

    // MARK: - Album art

    private var artwork: some View {
        Group {
            if let image = media.artwork {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.white.opacity(0.08))
                    .overlay {
                        Image(systemName: "music.note")
                            .font(.system(size: 32, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .frame(width: 96, height: 96)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .matchedGeometryEffect(id: "artwork", in: namespace)
    }

    // MARK: - Title / artist

    private var info: some View {
        VStack(alignment: .leading, spacing: 2) {
            MarqueeText(text: media.track.title, font: .headline, isActive: true)
            Text(media.track.artist)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    // MARK: - Transport

    private var transport: some View {
        HStack(spacing: 12) {
            if media.capabilities.contains(.shuffle) {
                GlassButton(systemName: "shuffle", size: 30) { media.send(.toggleShuffle) }
            }
            GlassButton(systemName: "backward.fill", size: 36) { media.send(.previous) }
            GlassButton(
                systemName: media.track.isPlaying ? "pause.fill" : "play.fill",
                size: 44
            ) { media.send(.playPause) }
            GlassButton(systemName: "forward.fill", size: 36) { media.send(.next) }
            if media.capabilities.contains(.repeatMode) {
                GlassButton(systemName: "repeat", size: 30) { media.send(.toggleRepeat) }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Seek bar

/// Draggable progress bar. While the track plays it advances on a 0.5s periodic
/// tick by interpolating the live position; during a scrub it tracks the finger and
/// commits with a single seek on release. No periodic loop while paused.
private struct SeekBar: View {
    let duration: TimeInterval
    let isPlaying: Bool
    let position: (Date) -> TimeInterval
    let onScrub: (TimeInterval) -> Void

    @State private var isScrubbing = false
    @State private var scrubPosition: TimeInterval = 0
    @State private var seekHoldTask: Task<Void, Never>?

    var body: some View {
        if isPlaying {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                bar(displayed: displayedPosition(asOf: context.date))
            }
        } else {
            bar(displayed: displayedPosition(asOf: Date()))
        }
    }

    private func displayedPosition(asOf date: Date) -> TimeInterval {
        isScrubbing ? scrubPosition : position(date)
    }

    private func bar(displayed: TimeInterval) -> some View {
        VStack(spacing: 4) {
            GeometryReader { proxy in
                let width = proxy.size.width
                let fraction = duration > 0 ? min(max(displayed / duration, 0), 1) : 0
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.18))
                    Capsule().fill(.white.opacity(0.85))
                        .frame(width: width * fraction)
                }
                .frame(height: 4)
                .frame(maxHeight: .infinity, alignment: .center)
                .contentShape(.rect)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            seekHoldTask?.cancel()
                            isScrubbing = true
                            scrubPosition = position(for: value.location.x, width: width)
                        }
                        .onEnded { value in
                            let target = position(for: value.location.x, width: width)
                            scrubPosition = target
                            onScrub(target)
                            holdUntilSeekLands(target)
                        }
                )
            }
            .frame(height: 14)

            HStack {
                Text(displayed.clockString)
                Spacer(minLength: 0)
                Text(duration.clockString)
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
        }
    }

    private func position(for x: CGFloat, width: CGFloat) -> TimeInterval {
        guard width > 0 else { return 0 }
        return min(max(x / width, 0), 1) * duration
    }

    /// The seek is async: clearing `isScrubbing` on release would let the next 0.5s
    /// tick render the pre-seek position, snapping the fill back until the player
    /// reports the new one. Keep showing the scrub target until the live position
    /// lands near it (or a short timeout), so the fill holds steady across the trip.
    private func holdUntilSeekLands(_ target: TimeInterval) {
        seekHoldTask?.cancel()
        seekHoldTask = Task { @MainActor in
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(100))
                if Task.isCancelled { return }
                if abs(position(Date()) - target) < 1.5 { break }
            }
            isScrubbing = false
        }
    }
}
