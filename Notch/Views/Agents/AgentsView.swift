import SwiftUI

/// The Agents tab: a list of live sessions (tap to jump to the terminal) above
/// per-agent Enable cards for integrations not yet opted in. Honest about each
/// agent's limits in the card subtitle.
struct AgentsView: View {
    @EnvironmentObject private var agents: AgentManager

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 10) {
                ForEach(agents.sessions) { session in
                    AgentRowView(session: session) { agents.jumpToTerminal(session) }
                }
                ForEach(disabledKinds, id: \.self) { kind in
                    enableCard(kind)
                }
                if agents.sessions.isEmpty && disabledKinds.isEmpty {
                    emptyState
                }
            }
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { agents.refresh() }
    }

    private var disabledKinds: [AgentKind] {
        agents.availableKinds.filter { !agents.isEnabled($0) }
    }

    private func enableCard(_ kind: AgentKind) -> some View {
        HStack(spacing: 12) {
            Image(systemName: kind.symbol)
                .font(.system(size: 18, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .frame(width: 26)

            VStack(alignment: .leading, spacing: 3) {
                Text(kind.displayName)
                    .font(.system(size: 13, weight: .semibold))
                Text(summary(kind))
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.55))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 10)

            Button {
                agents.setEnabled(true, for: kind)
            } label: {
                Text("Enable")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular, in: .capsule)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "terminal")
                .font(.system(size: 22))
                .foregroundStyle(.white.opacity(0.4))
            Text("No active agents")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
            Text("Run an enabled agent in a project to see it here.")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.45))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }

    private func summary(_ kind: AgentKind) -> String {
        switch kind {
        case .claudeCode:
            return "Live status, needs-you, and finished. Adds fire-and-forget hooks to ~/.claude/settings.json."
        case .codex:
            return "Live status, needs-you, and finished via ~/.codex/hooks.json (Codex asks you to trust the hook on first run)."
        case .openCode:
            return "Live status + needs-you via a small plugin in ~/.config/opencode/plugins."
        case .ohMyPi:
            return "Live status + needs-you via an extension in ~/.omp/agent/extensions."
        }
    }
}
