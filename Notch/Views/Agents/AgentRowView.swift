import SwiftUI

/// One agent session row: glyph, project, status dot + label + branch, uptime,
/// and a jump affordance. Tapping the row brings the hosting terminal forward.
struct AgentRowView: View {
    let session: AgentSession
    let onJump: () -> Void

    var body: some View {
        Button(action: onJump) {
            HStack(spacing: 12) {
                Image(systemName: session.kind.symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .frame(width: 26)

                VStack(alignment: .leading, spacing: 3) {
                    Text(session.project)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 6, height: 6)
                        Text(session.status.label)
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.6))
                        if let branch = session.gitBranch, !branch.isEmpty {
                            Text("· \(branch)")
                                .font(.system(size: 11))
                                .foregroundStyle(.white.opacity(0.4))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }

                Spacer(minLength: 8)

                HStack(spacing: 7) {
                    Text(uptime)
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(.white.opacity(0.5))
                    Image(systemName: "arrow.up.forward.app")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.4))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        .accessibilityLabel("\(session.kind.displayName) in \(session.project), \(session.status.label). Jump to terminal.")
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
}
