import NotchCore
import SwiftUI

/// All per-`Kind` presentation for an `Activity` in one place: the compact pill's
/// symbol and trailing label, plus the expanded card's title/subtitle/tint. Kept
/// off the `Activity` model so the data type stays presentation-free — and so the
/// pill's reserved width and its rendered label read this one source, instead of
/// a producer being able to shift notch geometry by editing a label on the model.
enum ActivityPresenter {
    /// Semantic icon key shown through the shared pixel glyph renderer.
    static func symbol(for kind: Activity.Kind) -> String {
        switch kind {
        case .nowPlaying: "music.note"
        case .charging: "bolt.fill"
        case .lowBattery: "battery.25"
        case .lowPowerMode: "battery.0"
        case let .deviceConnected(_, symbol, _): symbol
        case let .audioRoute(_, symbol): symbol
        case let .focus(_, isOn): isOn ? "moon.fill" : "moon"
        case let .peek(_, _, symbol, _): symbol
        case .timer: "timer"
        case let .agent(_, kind, _, _): kind.symbol
        case .screenshotCandidates: "photo"
        }
    }

    /// Trailing text in the compact pill. Empty for now-playing (the equalizer
    /// renders there instead). The pill reserves its width from this string, so
    /// the view and the layout must read the same value.
    static func compactLabel(for kind: Activity.Kind) -> String {
        switch kind {
        case .nowPlaying: ""
        case let .charging(percent, _, _): "\(percent)%"
        case let .lowBattery(percent): "\(percent)%"
        case .lowPowerMode: "Low Power"
        case let .deviceConnected(name, _, battery): battery.map { "\($0)%" } ?? name
        case let .audioRoute(name, _): name
        case let .focus(name, _): name ?? "Focus"
        case let .peek(title, _, _, _): title
        // The pill draws the live countdown (see CompactView), not the name, so
        // reserve width for the clock — that string is what actually gets rendered.
        case let .timer(_, endsAt, pausedRemaining):
            (pausedRemaining ?? max(0, endsAt.timeIntervalSinceNow)).clockString
        // Terse in the pill (it hugs the notch); the pixel glyph shows activity,
        // the expanded card carries detail. Show the count when more than one runs.
        case let .agent(count, _, _, status): count > 1 ? "\(count) agents" : status.label
        case let .screenshotCandidates(candidates):
            ScreenshotCandidatePolicy.coalescedLabel(count: candidates.count)
        }
    }

    struct Card {
        var title: String
        var subtitle: String?
        var tint: Color
    }

    /// Title, subtitle, and tint for the expanded activity card.
    static func card(for kind: Activity.Kind) -> Card {
        switch kind {
        case .nowPlaying:
            return Card(title: "Now Playing", subtitle: nil, tint: .white)

        case let .charging(percent, _, isFull):
            return Card(title: isFull ? "Charged" : "Charging", subtitle: "\(percent)%", tint: .green)

        case let .lowBattery(percent):
            return Card(title: "Low Battery", subtitle: "\(percent)%", tint: .red)

        case let .lowPowerMode(on):
            return Card(title: "Low Power Mode", subtitle: on ? "On" : "Off", tint: .yellow)

        case let .deviceConnected(name, _, battery):
            return Card(title: name, subtitle: battery.map { "\($0)%" } ?? "Connected", tint: .white)

        case let .audioRoute(name, _):
            return Card(title: "Output", subtitle: name, tint: .white)

        case let .focus(name, isOn):
            return Card(title: name ?? "Focus", subtitle: isOn ? "On" : "Off", tint: .white)

        case let .peek(title, message, _, tint):
            return Card(title: title, subtitle: message, tint: color(for: tint))

        // Snapshot of time left; the card re-renders when its activity changes, so
        // this avoids pinning a render loop just to tick a subtitle.
        case let .timer(name, endsAt, pausedRemaining):
            if let pausedRemaining {
                return Card(title: name, subtitle: "Paused · \(pausedRemaining.clockString)", tint: .white)
            }
            return Card(title: name, subtitle: max(0, endsAt.timeIntervalSinceNow).clockString, tint: .white)

        case let .agent(count, kind, project, status):
            let subtitle = count > 1
                ? "\(count) agents · \(status.label)"
                : "\(kind.shortName) · \(status.label)"
            return Card(title: count > 1 ? "Agents" : project, subtitle: subtitle, tint: agentTint(status))

        case let .screenshotCandidates(candidates):
            return Card(
                title: ScreenshotCandidatePolicy.coalescedLabel(count: candidates.count),
                subtitle: "Add to Shelf, preview, or dismiss",
                tint: .cyan
            )
        }
    }

    /// Capitalized aggregate status for the compact agent pill's leading label.
    /// The strings must stay in sync with the widest-label list measured in
    /// `NotchLayout.compactAgentSlotWidth`.
    static func agentCompactStatus(_ status: AgentStatus) -> String {
        switch status {
        case .running: "Running"
        case .editing: "Editing"
        case .tool: "Working"
        case .idle: "Idle"
        case .needsAttention: "Needs you"
        case .finished: "Done"
        }
    }

    /// Retro-green working look specific to the pill's pixel spinner glyphs;
    /// attention/finished keep the canonical `agentTint` palette.
    static let agentWorkingTint = Color(red: 0.40, green: 0.92, blue: 0.55)

    /// Canonical status → color for the agent feature, so the pill, the card, and
    /// the session rows can't drift apart (they used to keep three copies).
    static func agentTint(_ status: AgentStatus) -> Color {
        switch status {
        case .needsAttention: .orange
        case .finished: .green
        case .running, .tool: .cyan
        case .editing: .blue
        case .idle: .white.opacity(0.6)
        }
    }

    private static func color(for tint: Activity.PeekTint) -> Color {
        switch tint {
        case .neutral: .white
        case .accent: .accentColor
        case .warning: .orange
        case .success: .green
        }
    }
}
