import SwiftUI

/// One activity rendered as a horizontal glass card: symbol + title + subtitle.
/// Used inside the expanded home surface and the activity cycle, so it sits on
/// content where glass is allowed (never on the black pill). Stays compact and
/// sizes to its text.
struct ActivityCardView: View {
    let activity: Activity
    var namespace: Namespace.ID? = nil

    var body: some View {
        let content = makeContent()

        HStack(spacing: 10) {
            Image(systemName: activity.compactSymbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(content.tint)
                .frame(width: 22)
                .symbolRenderingMode(.hierarchical)

            VStack(alignment: .leading, spacing: 1) {
                Text(content.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                if let subtitle = content.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.65))
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Derived content

    private struct CardContent {
        var title: String
        var subtitle: String?
        var tint: Color
    }

    private func makeContent() -> CardContent {
        switch activity.kind {
        case .nowPlaying:
            return CardContent(title: "Now Playing", subtitle: nil, tint: .white)

        case let .charging(percent, _, isFull):
            return CardContent(title: isFull ? "Charged" : "Charging",
                               subtitle: "\(percent)%",
                               tint: .green)

        case let .lowBattery(percent):
            return CardContent(title: "Low Battery",
                               subtitle: "\(percent)%",
                               tint: .red)

        case let .lowPowerMode(on):
            return CardContent(title: "Low Power Mode",
                               subtitle: on ? "On" : "Off",
                               tint: .yellow)

        case let .deviceConnected(name, _, battery):
            return CardContent(title: name,
                               subtitle: battery.map { "\($0)%" } ?? "Connected",
                               tint: .white)

        case let .audioRoute(name, _):
            return CardContent(title: "Output", subtitle: name, tint: .white)

        case let .focus(name, isOn):
            return CardContent(title: name ?? "Focus",
                               subtitle: isOn ? "On" : "Off",
                               tint: .white)

        case let .peek(title, message, _, tint):
            return CardContent(title: title, subtitle: message, tint: color(for: tint))

        case let .timer(name, endsAt):
            return CardContent(title: name, subtitle: remaining(until: endsAt), tint: .white)

        case let .agent(count, kind, project, status):
            let subtitle = count > 1
                ? "\(count) agents · \(status.label)"
                : "\(kind.shortName) · \(status.label)"
            return CardContent(title: count > 1 ? "Agents" : project, subtitle: subtitle, tint: agentTint(status))
        }
    }

    private func agentTint(_ status: AgentStatus) -> Color {
        switch status {
        case .needsAttention: return .orange
        case .finished: return .green
        case .editing, .running, .tool: return .white
        case .idle: return .white.opacity(0.6)
        }
    }

    private func color(for tint: Activity.PeekTint) -> Color {
        switch tint {
        case .neutral: return .white
        case .accent: return .accentColor
        case .warning: return .orange
        case .success: return .green
        }
    }

    /// Snapshot of time left; the card re-renders when its activity changes, so we
    /// avoid pinning a render loop just to tick a label.
    private func remaining(until end: Date) -> String {
        max(0, end.timeIntervalSinceNow).clockString
    }
}
