import SwiftUI

/// One pixel glyph per watched agent session: a tiny 4×4 equalizer whose bars
/// step pseudo-randomly while that session works. All glyphs share a single
/// `TimelineView` tick (mounted only while the compact pill is on-screen and at
/// least one session is busy), so idle stays a zero render loop.
struct PixelSessionStrip: View {
    struct Entry: Identifiable, Equatable {
        let id: String
        var busy: Bool
        var tint: Color
    }

    var entries: [Entry]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let step: TimeInterval = 0.16

    var body: some View {
        Group {
            if entries.contains(where: \.busy) {
                TimelineView(.periodic(from: .now, by: step)) { context in
                    strip(frame: Int(context.date.timeIntervalSinceReferenceDate / step))
                }
            } else {
                strip(frame: -1)
            }
        }
        // Ease tint shifts (working blue -> attention orange) so a status change
        // reads as a transition, not a hard cut. Only fires when entries change,
        // so the per-frame tick stays a zero-cost render.
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: entries)
    }

    private func strip(frame: Int) -> some View {
        HStack(spacing: NotchLayout.agentGlyphSpacing) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                // Offset each session's frame so neighbours animate out of phase.
                PixelEqualizerGlyph(
                    frame: entry.busy && frame >= 0 ? frame &+ index &* 3 : -1,
                    tint: entry.tint
                )
            }
        }
        .accessibilityHidden(true)
    }
}

/// A 4×4 pixel bar meter. `frame < 0` renders the resting shape; otherwise bar
/// heights derive from a deterministic hash of (frame, column), so the animation
/// is lively without any stored state.
struct PixelEqualizerGlyph: View {
    var frame: Int
    var tint: Color

    private let columns = 4
    private let rows = 4
    private let cell: CGFloat = 2.5
    private let gap: CGFloat = 1

    private static let restingHeights = [1, 3, 2, 1]

    var body: some View {
        HStack(alignment: .bottom, spacing: gap) {
            ForEach(0..<columns, id: \.self) { column in
                let lit = barHeight(column: column)
                VStack(spacing: gap) {
                    ForEach(0..<rows, id: \.self) { row in
                        Rectangle()
                            .fill(tint.opacity(rows - row <= lit ? 1.0 : 0.15))
                            .frame(width: cell, height: cell)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func barHeight(column: Int) -> Int {
        guard frame >= 0 else { return Self.restingHeights[column] }
        var hash = UInt32(truncatingIfNeeded: frame) &* 2_654_435_761
            &+ UInt32(truncatingIfNeeded: column) &* 40_503
        hash ^= hash >> 13
        return 1 + Int(hash % UInt32(rows))
    }
}
