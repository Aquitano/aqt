import NotchCore
import SwiftUI

/// One agent session as a rich card: agent glyph, "project · prompt" title,
/// status dot, agent/terminal badges, branch + uptime, and a preview of the
/// latest exchange. Tapping jumps to the hosting terminal tab. Long-idle
/// sessions render `collapsed`: a single quiet line so a day's worth of
/// finished sessions doesn't drown the ones still working.
///
/// A detached session (window gone, process still running) keeps its row but
/// loses the tap: there is no tab to land on, so the row offers to quit it.
struct AgentRowView: View {
    let session: AgentSession
    var collapsed = false
    let onJump: () -> Void
    var onQuit: () -> Void = {}

    /// Quit is a one-way action on a session nothing else can reach, so the
    /// button asks once before it fires.
    @State private var quitArmed = false

    var body: some View {
        card
            .glassEffect(.regular, in: .rect(cornerRadius: collapsed ? 12 : 16))
            .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var card: some View {
        if session.isDetached {
            layout
        } else {
            Button(action: onJump) { layout }
                .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var layout: some View {
        if collapsed {
            compactBody
        } else {
            fullBody
        }
    }

    private var fullBody: some View {
        HStack(alignment: .top, spacing: 12) {
            PixelIcon(systemName: session.kind.symbol, size: 18, tint: kindTint)
                .frame(width: 26)

            VStack(alignment: .leading, spacing: 5) {
                title
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                metaRow

                if let response = session.lastResponse, !response.isEmpty {
                    Text(response)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.45))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    private var compactBody: some View {
        HStack(spacing: 8) {
            PixelIcon(systemName: session.kind.symbol, size: 12, tint: kindTint.opacity(0.7))
                .frame(width: 18)
            Text(session.project)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(1)
                .truncationMode(.tail)
            Circle().fill(statusColor.opacity(0.7)).frame(width: 5, height: 5)
            Text("\(session.status.label) \(sinceActivity)")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.4))
                .lineLimit(1)
            Spacer(minLength: 6)
            if session.isDetached {
                quitButton
            } else if let terminal = session.terminalName {
                Text(terminal)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.35))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    private var title: Text {
        let project = Text(session.project)
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
        if let prompt = session.lastPrompt, !prompt.isEmpty {
            let detail = Text(prompt)
                .font(.body)
                .foregroundStyle(.white.opacity(0.5))
            return Text("\(project)  \(detail)")
        }
        return project
    }

    private var metaRow: some View {
        HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 6, height: 6)
            Text(session.activityVerb ?? session.status.label)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
                .truncationMode(.tail)
            if let branch = session.gitBranch, !branch.isEmpty {
                Text("· \(branch)")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.4))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 6)

            badge(session.kind.shortName, tint: kindTint)
            if session.isDetached {
                badge("Detached", tint: .orange)
                quitButton
            } else if let terminal = session.terminalName {
                badge(terminal, tint: .white.opacity(0.5))
            }
            Text(uptime)
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.45))
        }
    }

    private var quitButton: some View {
        Button {
            Haptics.tap(.levelChange)
            if quitArmed {
                onQuit()
            } else {
                quitArmed = true
            }
        } label: {
            Text(quitArmed ? "Quit?" : "Quit")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.red.opacity(quitArmed ? 0.4 : 0.18), in: .capsule)
                .foregroundStyle(quitArmed ? Color.white : Color.red)
                .fixedSize()
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(quitArmed ? "Confirm quitting this session" : "Quit this session")
        // Disarm on its own so a half-pressed row can't fire on a later stray tap.
        .task(id: quitArmed) {
            guard quitArmed else { return }
            try? await Task.sleep(for: .seconds(4))
            quitArmed = false
        }
    }

    private func badge(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.18), in: .capsule)
            .foregroundStyle(tint)
            .fixedSize()
    }

    private var kindTint: Color {
        switch session.kind {
        case .claudeCode: Color(red: 0.85, green: 0.55, blue: 0.35) // Claude amber
        case .codex: .green
        case .openCode: .cyan
        case .ohMyPi: .mint
        case .t3code: .purple
        }
    }

    private var statusColor: Color {
        ActivityPresenter.agentTint(session.status)
    }

    private var uptime: String {
        Self.duration(since: session.startedAt)
    }

    private var sinceActivity: String {
        Self.duration(since: session.lastActivity)
    }

    private static func duration(since date: Date) -> String {
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 {
            return "\(seconds)s"
        }
        if seconds < 3600 {
            return "\(seconds / 60)m"
        }
        return "\(seconds / 3600)h\((seconds % 3600) / 60)m"
    }

    private var accessibilityText: String {
        var parts = ["\(session.kind.displayName) in \(session.project)", session.status.label]
        if let prompt = session.lastPrompt {
            parts.append("prompt: \(prompt)")
        }
        parts.append(session.isDetached ? "detached, no terminal to jump to" : "jump to terminal")
        return parts.joined(separator: ", ")
    }
}
