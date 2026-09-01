import SwiftUI
import NotchCore

/// Single-line label that gently scrolls when its text is wider than the space
/// it's given. Scrolling only happens while `isActive` (the caller gates this on
/// expansion / playback) and only when the text actually overflows. Otherwise it
/// falls back to a plain tail-truncated label.
///
/// The motion is driven by an explicit `.task` loop that flips a target offset
/// and animates each leg with `withAnimation`. No `repeatForever`, no mounted
/// `TimelineView(.animation)`; between legs the task simply sleeps, so an idle or
/// non-overflowing label costs nothing.
struct MarqueeText: View {
    let text: String
    var font: Font = .body
    var isActive: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var containerWidth: CGFloat = 0
    @State private var textWidth: CGFloat = 0
    @State private var offset: CGFloat = 0

    private let pointsPerSecond: Double = 28
    private let endPause: Double = 1.0
    private let startPause: Double = 1.2

    private var overflow: CGFloat { max(0, textWidth - containerWidth) }

    private var shouldScroll: Bool {
        isActive && !reduceMotion && overflow > 0.5
    }

    private var legDuration: Double {
        max(2.0, Double(overflow) / pointsPerSecond)
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: ContainerWidthKey.self, value: proxy.size.width)
                }
            }
            .background(alignment: .leading) { widthProbe }
            .clipped()
            .onPreferenceChange(ContainerWidthKey.self) { containerWidth = $0 }
            .onPreferenceChange(TextWidthKey.self) { textWidth = $0 }
            .task(id: ScrollKey(active: shouldScroll, distance: overflow.rounded(), text: text)) {
                await runScroll()
            }
    }

    @ViewBuilder
    private var content: some View {
        if shouldScroll {
            Text(text)
                .font(font)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .offset(x: offset)
        } else {
            Text(text)
                .font(font)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    /// Hidden copy of the text at its natural width, used only to measure overflow.
    private var widthProbe: some View {
        Text(text)
            .font(font)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: TextWidthKey.self, value: proxy.size.width)
                }
            }
            .hidden()
            .allowsHitTesting(false)
    }

    private func runScroll() async {
        offset = 0
        guard shouldScroll else { return }

        let distance = overflow
        let duration = legDuration
        let curve = Animation.easeInOut(duration: duration)

        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(startPause))
            if Task.isCancelled { break }
            withAnimation(curve) { offset = -distance }

            try? await Task.sleep(for: .seconds(duration + endPause))
            if Task.isCancelled { break }
            withAnimation(curve) { offset = 0 }

            try? await Task.sleep(for: .seconds(duration + endPause))
        }
    }
}

// MARK: - Measurement

private struct ContainerWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct TextWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Restarts the scroll loop whenever activity, overflow distance, or the text changes.
private struct ScrollKey: Equatable {
    let active: Bool
    let distance: CGFloat
    let text: String
}
