import SwiftUI

/// The timer tab: a Focus/Break selector, a scrubbable tick dial, and the
/// running countdown. Phase decisions live in `PomodoroPolicy`; the view only
/// renders `TimerManager`'s published state.
struct TimerPanelView: View {
    @EnvironmentObject private var timer: TimerManager
    @EnvironmentObject private var settings: Settings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            if timer.runState == .idle {
                phasePicker
                TimerDial(minutes: minutesBinding,
                          range: PomodoroPolicy.minuteRange,
                          tint: tint)
                idleControls
            } else {
                runningHeader
                countdown
                runningControls
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(NotchAnimation.morph(reduceMotion: reduceMotion), value: timer.runState)
    }

    // MARK: - Derived

    private static func tint(for phase: PomodoroPhase) -> Color {
        switch phase {
        case .focus: return .orange
        case .rest: return .mint
        }
    }

    private var tint: Color {
        Self.tint(for: timer.activePhase ?? timer.selectedPhase)
    }

    /// The dial edits the phase's saved duration directly, so the last choice
    /// per phase survives relaunches.
    private var minutesBinding: Binding<Int> {
        switch timer.selectedPhase {
        case .focus: return $settings.pomodoroFocusMinutes
        case .rest: return $settings.pomodoroBreakMinutes
        }
    }

    // MARK: - Idle

    private var phasePicker: some View {
        ZStack {
            HStack(spacing: 6) {
                ForEach(PomodoroPhase.allCases) { phase in
                    phaseChip(phase)
                }
            }
            if timer.completedFocusSessions > 0 {
                HStack {
                    Spacer()
                    sessionDots
                }
            }
        }
    }

    private func phaseChip(_ phase: PomodoroPhase) -> some View {
        let selected = timer.selectedPhase == phase
        let chipTint = Self.tint(for: phase)
        return Button {
            Haptics.tap(.levelChange)
            timer.selectedPhase = phase
        } label: {
            Text(phase.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(selected ? chipTint : .white.opacity(0.6))
                .padding(.horizontal, 14)
                .frame(height: 28)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(selected ? .regular.tint(chipTint.opacity(0.25)) : .regular, in: .capsule)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var idleControls: some View {
        HStack {
            Button {
                Haptics.tap(.alignment)
                timer.start(phase: timer.selectedPhase, minutes: minutesBinding.wrappedValue)
            } label: {
                Text("Start Timer")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                    .padding(.horizontal, 18)
                    .frame(height: 36)
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.tint(tint.opacity(0.25)), in: .capsule)

            Spacer()

            Text(String(format: "%d:00", minutesBinding.wrappedValue))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(tint)
                .contentTransition(.numericText())
                .animation(reduceMotion ? nil : .snappy(duration: 0.2),
                           value: minutesBinding.wrappedValue)
        }
        .padding(.horizontal, Theme.Spacing.tiny)
    }

    // MARK: - Running

    private var runningHeader: some View {
        ZStack {
            Text((timer.activePhase ?? timer.selectedPhase).title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.horizontal, 14)
                .frame(height: 28)
                .glassEffect(.regular.tint(tint.opacity(0.25)), in: .capsule)
            if timer.completedFocusSessions > 0 {
                HStack {
                    Spacer()
                    sessionDots
                }
            }
        }
    }

    @ViewBuilder
    private var countdown: some View {
        if let pausedRemaining = timer.pausedRemaining {
            countdownBody(remaining: pausedRemaining, paused: true)
        } else if let endsAt = timer.endsAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                countdownBody(remaining: max(0, endsAt.timeIntervalSince(context.date)), paused: false)
            }
        }
    }

    private func countdownBody(remaining: TimeInterval, paused: Bool) -> some View {
        VStack(spacing: 10) {
            Text(remaining.clockString)
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(tint.opacity(paused ? 0.5 : 1))

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.15))
                    Capsule()
                        .fill(tint)
                        .frame(width: geo.size.width * progressFraction(remaining: remaining))
                }
            }
            .frame(width: 220, height: 4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(remaining.clockString) remaining\(paused ? ", paused" : "")")
    }

    private func progressFraction(remaining: TimeInterval) -> CGFloat {
        guard timer.totalDuration > 0 else { return 0 }
        return min(1, max(0, 1 - remaining / timer.totalDuration))
    }

    private var runningControls: some View {
        HStack(spacing: Theme.Spacing.medium) {
            GlassButton(systemName: "xmark") {
                Haptics.tap(.levelChange)
                timer.cancel()
            }
            GlassButton(systemName: timer.runState == .paused ? "play.fill" : "pause.fill",
                        size: 40) {
                Haptics.tap(.levelChange)
                timer.runState == .paused ? timer.resume() : timer.pause()
            }
        }
    }

    /// One dot per completed focus session, capped so a long day stays a hint,
    /// not a scoreboard.
    private var sessionDots: some View {
        HStack(spacing: 4) {
            ForEach(0..<min(timer.completedFocusSessions, 6), id: \.self) { _ in
                Circle()
                    .fill(Self.tint(for: .focus).opacity(0.8))
                    .frame(width: 5, height: 5)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(timer.completedFocusSessions) focus sessions completed")
    }
}

/// Horizontal tape-measure dial: one tick per minute, labels every five, the
/// selected minute centered over a fixed indicator. Dragging scrubs the value;
/// each snapped minute taps the haptic engine.
private struct TimerDial: View {
    @Binding var minutes: Int
    let range: ClosedRange<Int>
    let tint: Color

    @State private var dragBaseMinutes: Int?

    private let tickSpacing: CGFloat = 9
    private let labelHeight: CGFloat = 18
    private let tickAreaHeight: CGFloat = 26

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, size in
            drawScale(context: context, size: size)
            drawIndicator(context: context, size: size)
        }
        .frame(height: labelHeight + tickAreaHeight + 12)
        .contentShape(.rect)
        .gesture(drag)
        .accessibilityElement()
        .accessibilityLabel("Timer duration")
        .accessibilityValue("\(minutes) minutes")
        .accessibilityAdjustableAction { direction in
            let step = direction == .increment ? 1 : -1
            minutes = PomodoroPolicy.clampedMinutes(minutes + step)
        }
    }

    private func drawScale(context: GraphicsContext, size: CGSize) {
        let centerX = size.width / 2
        for value in range {
            let x = centerX + CGFloat(value - minutes) * tickSpacing
            guard x > -tickSpacing, x < size.width + tickSpacing else { continue }

            let distance = abs(x - centerX)
            // The scale is white near the indicator and phase-tinted further out,
            // fading toward the edges — the same read as the reference dial.
            let nearCenter = distance < tickSpacing * 2.5
            let fade = max(0.25, 1 - distance / (size.width * 0.62))
            let color = (nearCenter ? Color.white : tint).opacity(fade)

            let isLabelTick = value % 5 == 0
            let tickHeight: CGFloat = value == minutes ? tickAreaHeight
                : (isLabelTick ? 20 : 13)
            let tickRect = CGRect(
                x: x - 0.75,
                y: labelHeight + (tickAreaHeight - tickHeight),
                width: 1.5,
                height: tickHeight
            )
            context.fill(Path(roundedRect: tickRect, cornerRadius: 0.75), with: .color(color))

            if isLabelTick {
                let label = context.resolve(
                    Text("\(value)")
                        .font(.system(size: 12, weight: value == minutes ? .bold : .medium))
                        .foregroundStyle(value == minutes ? Color.white : color)
                )
                context.draw(label, at: CGPoint(x: x, y: labelHeight / 2), anchor: .center)
            }
        }
    }

    private func drawIndicator(context: GraphicsContext, size: CGSize) {
        let centerX = size.width / 2
        let top = labelHeight + tickAreaHeight + 3
        var triangle = Path()
        triangle.move(to: CGPoint(x: centerX, y: top))
        triangle.addLine(to: CGPoint(x: centerX - 4.5, y: top + 7))
        triangle.addLine(to: CGPoint(x: centerX + 4.5, y: top + 7))
        triangle.closeSubpath()
        context.fill(triangle, with: .color(tint))
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                let base = dragBaseMinutes ?? minutes
                dragBaseMinutes = base
                let delta = Int((-value.translation.width / tickSpacing).rounded())
                let updated = PomodoroPolicy.clampedMinutes(base + delta)
                if updated != minutes {
                    minutes = updated
                    Haptics.tap(.levelChange)
                }
            }
            .onEnded { _ in dragBaseMinutes = nil }
    }
}
