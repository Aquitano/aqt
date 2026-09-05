import NotchCore
import SwiftUI

/// A small retro pixel "spinner": a 3×3 grid whose perimeter lights a moving
/// two-cell comet while an agent works. Animation is scoped to a `TimelineView`
/// that only ticks while this view is mounted (the compact pill is ordered out
/// when hidden) and only while `active`, so idle stays a zero render loop.
struct PixelWorkingIndicator: View {
    var active: Bool
    var tint: Color = .green

    private let cell: CGFloat = 3.5
    private let gap: CGFloat = 1.5
    private let step: TimeInterval = 0.13

    /// Perimeter cells of the 3×3 grid in clockwise order.
    private static let ring: [(row: Int, col: Int)] = [
        (0, 0), (0, 1), (0, 2), (1, 2), (2, 2), (2, 1), (2, 0), (1, 0),
    ]

    var body: some View {
        if active {
            TimelineView(.periodic(from: .now, by: step)) { context in
                let frame = Int(context.date.timeIntervalSinceReferenceDate / step) % Self.ring.count
                grid(frame: frame)
            }
        } else {
            grid(frame: -1)
        }
    }

    private func grid(frame: Int) -> some View {
        let lit: Set<Int> = frame < 0 ? [] : [frame, (frame + 1) % Self.ring.count]
        return VStack(spacing: gap) {
            ForEach(0 ..< 3, id: \.self) { row in
                HStack(spacing: gap) {
                    ForEach(0 ..< 3, id: \.self) { col in
                        Rectangle()
                            .fill(tint.opacity(opacity(row: row, col: col, lit: lit)))
                            .frame(width: cell, height: cell)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func opacity(row: Int, col: Int, lit: Set<Int>) -> Double {
        if row == 1 && col == 1 {
            return 0.28
        } // dim center
        guard let index = Self.ring.firstIndex(where: { $0.row == row && $0.col == col }) else { return 0.18 }
        return lit.contains(index) ? 1.0 : 0.18
    }
}
