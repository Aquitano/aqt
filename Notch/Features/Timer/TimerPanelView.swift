import SwiftUI
import NotchCore
import AppKit

/// The timer tab: a Focus/Break selector, a scrubbable tick dial, and the
/// running countdown. Phase decisions live in `PomodoroPolicy`; the view only
/// renders `TimerManager`'s published state.
struct TimerPanelView: View {
    @Environment(TimerManager.self) private var timer
    @Environment(Settings.self) private var settings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Namespace private var chipNamespace

    var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            if timer.runState == .idle {
                Group {
                    phasePicker
                    TimerDial(minutes: minutesBinding,
                              range: PomodoroPolicy.minuteRange,
                              tint: tint)
                    idleControls
                }
                .transition(.blurReplace)
            } else {
                Group {
                    runningHeader
                    countdown
                    runningControls
                }
                .transition(.blurReplace)
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
        let settings = Bindable(settings)
        switch timer.selectedPhase {
        case .focus: return settings.widgets.pomodoroFocusMinutes
        case .rest: return settings.widgets.pomodoroBreakMinutes
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
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) {
                timer.selectedPhase = phase
            }
        } label: {
            Text(phase.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(selected ? chipTint : .white.opacity(0.6))
                .padding(.horizontal, 14)
                .frame(height: 28)
                .background {
                    // One shared highlight that glides between the chips as the
                    // phase changes, mirroring the tab strip's selection pill.
                    if selected {
                        Capsule(style: .continuous)
                            .fill(chipTint.opacity(0.22))
                            .matchedGeometryEffect(id: "phaseSelection", in: chipNamespace)
                    }
                }
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular, in: .capsule)
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

            // Rolls only inside animated transactions (the phase-switch glide);
            // scrub and scroll updates carry no animation so fast changes stay
            // a crisp direct readout instead of mushing digit transitions.
            Text(String(format: "%d:00", minutesBinding.wrappedValue))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(tint)
                .contentTransition(.numericText(value: Double(minutesBinding.wrappedValue)))
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
                // Digits roll downward each second instead of hard-cutting.
                .contentTransition(.numericText(countsDown: true))
                .animation(reduceMotion ? nil : .smooth(duration: 0.35),
                           value: Int(remaining.rounded()))

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.15))
                    Capsule()
                        .fill(tint)
                        .frame(width: geo.size.width * progressFraction(remaining: remaining))
                }
            }
            .frame(width: 220, height: 4)
            .animation(reduceMotion ? nil : .linear(duration: 1), value: remaining)
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
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : NotchAnimation.pop, value: timer.completedFocusSessions)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(timer.completedFocusSessions) focus sessions completed")
    }
}

/// Scroll events over the expanded timer tab, forwarded by the window
/// controller's proven scroll monitor (a view-local monitor is unreliable on
/// the non-activating panel).
extension Notification.Name {
    static let timerDialScroll = Notification.Name("app.notch.timerDialScroll")
}

enum TimerDialScroll {
    static let deltaY = "deltaY"
    static let precise = "precise"
}

/// Horizontal tape-measure dial: one tick per minute, labels every five, the
/// selected minute centered over a fixed indicator. Dragging scrubs the value,
/// the scroll wheel nudges it while the timer tab is open, and each snapped
/// minute taps the haptic engine. Dragging tracks the finger 1:1; scroll and
/// accessibility steps glide the tape to the new minute (the animatable
/// offset retargets smoothly under rapid wheel events), and the phase switch
/// glides via the chip's animated transaction.
private struct TimerDial: View {
    @Binding var minutes: Int
    let range: ClosedRange<Int>
    let tint: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragBaseMinutes: Int?
    @State private var scrollAccumulator: CGFloat = 0

    private static let tickSpacing: CGFloat = 9
    /// Precise (trackpad) scroll points per one-minute step.
    private static let scrollPointsPerStep: CGFloat = 12

    var body: some View {
        DialScale(offsetMinutes: CGFloat(minutes), range: range, tint: tint)
            .frame(height: 56)
            .contentShape(.rect)
            .gesture(drag)
            .onReceive(NotificationCenter.default.publisher(for: .timerDialScroll)) { note in
                handleScroll(note)
            }
            .accessibilityElement()
            .accessibilityLabel("Timer duration")
            .accessibilityValue("\(minutes) minutes")
            .accessibilityAdjustableAction { direction in
                adjust(by: direction == .increment ? 1 : -1, animated: true)
            }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                let base = dragBaseMinutes ?? minutes
                dragBaseMinutes = base
                let delta = Int((-value.translation.width / Self.tickSpacing).rounded())
                adjust(by: PomodoroPolicy.clampedMinutes(base + delta) - minutes)
            }
            .onEnded { _ in dragBaseMinutes = nil }
    }

    private func handleScroll(_ note: Notification) {
        guard let deltaY = note.userInfo?[TimerDialScroll.deltaY] as? CGFloat,
              let precise = note.userInfo?[TimerDialScroll.precise] as? Bool else { return }
        // Scrolling up (fingers up under natural scrolling: negative deltaY)
        // increases the duration, matching how sliders and steppers respond.
        if precise {
            scrollAccumulator -= deltaY
            let steps = Int(scrollAccumulator / Self.scrollPointsPerStep)
            guard steps != 0 else { return }
            scrollAccumulator -= CGFloat(steps) * Self.scrollPointsPerStep
            adjust(by: steps, animated: true)
        } else if deltaY != 0 {
            // A clicky mouse wheel: one detent, one minute.
            adjust(by: deltaY < 0 ? 1 : -1, animated: true)
        }
    }

    private func adjust(by steps: Int, animated: Bool = false) {
        let updated = PomodoroPolicy.clampedMinutes(minutes + steps)
        guard updated != minutes else { return }
        withAnimation(animated && !reduceMotion ? .snappy(duration: 0.22) : nil) {
            minutes = updated
        }
        Haptics.tap(.levelChange)
    }
}

/// The drawn tape. `offsetMinutes` is the animatable position of the scale, so
/// SwiftUI interpolates it frame by frame; emphasis (tick height, label color)
/// derives from continuous distance to the centerline and rolls across the
/// tape as it moves.
private struct DialScale: View, Animatable {
    var offsetMinutes: CGFloat
    let range: ClosedRange<Int>
    let tint: Color

    var animatableData: CGFloat {
        get { offsetMinutes }
        set { offsetMinutes = newValue }
    }

    private let tickSpacing: CGFloat = 9
    private let labelHeight: CGFloat = 18
    private let tickAreaHeight: CGFloat = 26

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, size in
            drawScale(context: context, size: size)
            drawIndicator(context: context, size: size)
        }
        .frame(height: labelHeight + tickAreaHeight + 12)
    }

    private func drawScale(context: GraphicsContext, size: CGSize) {
        let centerX = size.width / 2
        for value in range {
            let x = centerX + (CGFloat(value) - offsetMinutes) * tickSpacing
            guard x > -tickSpacing, x < size.width + tickSpacing else { continue }

            // Continuous emphasis: 1 at the centerline, 0 one tick away — the
            // white highlight hands over smoothly while the tape glides.
            let distance = abs(x - centerX)
            let emphasis = max(0, 1 - distance / tickSpacing)
            let nearCenter = distance < tickSpacing * 2.5
            let fade = max(0.25, 1 - distance / (size.width * 0.62))
            let color = (nearCenter ? Color.white : tint).opacity(fade)

            let isLabelTick = value % 5 == 0
            let baseHeight: CGFloat = isLabelTick ? 20 : 13
            let tickHeight = baseHeight + (tickAreaHeight - baseHeight) * emphasis
            let tickRect = CGRect(
                x: x - 0.75,
                y: labelHeight + (tickAreaHeight - tickHeight),
                width: 1.5,
                height: tickHeight
            )
            context.fill(Path(roundedRect: tickRect, cornerRadius: 0.75), with: .color(color))

            if isLabelTick {
                let selected = emphasis > 0.5
                let label = context.resolve(
                    Text("\(value)")
                        .font(.system(size: 12, weight: selected ? .bold : .medium))
                        .foregroundStyle(selected ? Color.white : color)
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
}
