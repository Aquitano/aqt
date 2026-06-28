import SwiftUI

/// One agent session as a rich card: agent glyph, "project · prompt" title,
/// status dot, agent/terminal badges, branch + uptime, and a preview of the
/// latest exchange. Tapping jumps to the hosting terminal tab.
struct AgentRowView: View {
    let session: AgentSession
    let onJump: () -> Void

    var body: some View {
        Button(action: onJump) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: session.kind.symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(kindTint)
                    .frame(width: 26)

                VStack(alignment: .leading, spacing: 5) {
                    title
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    metaRow

                    if let response = session.lastResponse, !response.isEmpty {
                        Text(response)
                            .font(.system(size: 11))
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
        .buttonStyle(.plain)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .accessibilityLabel(accessibilityText)
    }

    private var title: Text {
        var text = Text(session.project)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
        if let prompt = session.lastPrompt, !prompt.isEmpty {
            text = text + Text("  \(prompt)")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.5))
        }
        return text
    }

    private var metaRow: some View {
        HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 6, height: 6)
            Text(session.activityVerb ?? session.status.label)
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
                .truncationMode(.tail)
            if let branch = session.gitBranch, !branch.isEmpty {
                Text("· \(branch)")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.4))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 6)

            badge(session.kind.shortName, tint: kindTint)
            if let terminal = session.terminalName {
                badge(terminal, tint: .white.opacity(0.5))
            }
            Text(uptime)
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.45))
        }
    }

    private func badge(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.18), in: .capsule)
            .foregroundStyle(tint)
            .fixedSize()
    }

    private var kindTint: Color {
        switch session.kind {
        case .claudeCode: return Color(red: 0.85, green: 0.55, blue: 0.35) // Claude amber
        case .codex: return .green
        case .openCode: return .cyan
        case .ohMyPi: return .mint
        }
    }

    private var statusColor: Color {
        switch session.status {
        case .running, .tool: return .cyan
        case .editing: return .blue
        case .needsAttention: return .orange
        case .finished: return .green
        case .idle: return .white.opacity(0.4)
        }
    }

    private var uptime: String {
        let seconds = max(0, Int(Date().timeIntervalSince(session.startedAt)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h\((seconds % 3600) / 60)m"
    }

    private var accessibilityText: String {
        var parts = ["\(session.kind.displayName) in \(session.project)", session.status.label]
        if let prompt = session.lastPrompt { parts.append("prompt: \(prompt)") }
        parts.append("jump to terminal")
        return parts.joined(separator: ", ")
    }
}
