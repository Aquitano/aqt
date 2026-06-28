import SwiftUI

/// The Agents tab: a list of live sessions (tap to jump to the terminal) above
/// per-agent Enable cards for integrations not yet opted in. Honest about each
/// agent's limits in the card subtitle.
struct AgentsView: View {
    @EnvironmentObject private var agents: AgentManager

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 10) {
                if let usage = agents.usage {
                    usagePanel(usage)
                }
                ForEach(topLevelSessions) { session in
                    AgentRowView(session: session) { agents.jumpToTerminal(session) }
                    // Sub-agents (e.g. OpenCode child sessions) nested under their parent.
                    ForEach(children(of: session)) { child in
                        AgentRowView(session: child) { agents.jumpToTerminal(child) }
                            .padding(.leading, 22)
                            .opacity(0.92)
                    }
                }
                ForEach(installableKinds, id: \.self) { kind in
                    enableCard(kind)
                }
                ForEach(notInstalledKinds, id: \.self) { kind in
                    notInstalledCard(kind)
                }
                if agents.sessions.isEmpty && installableKinds.isEmpty {
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

    /// Disabled-but-installed agents get an Enable card; the rest show as a quiet
    /// "not installed" row so it's clear they're supported.
    private var installableKinds: [AgentKind] { disabledKinds.filter { agents.isInstalled($0) } }
    private var notInstalledKinds: [AgentKind] { disabledKinds.filter { !agents.isInstalled($0) } }

    /// Sessions with no parent (or whose parent isn't currently shown) render at
    /// the top level; their sub-agents nest underneath.
    private var topLevelSessions: [AgentSession] {
        let ids = Set(agents.sessions.map(\.id))
        return agents.sessions.filter { session in
            guard let parent = session.parentSessionID else { return true }
            return !ids.contains(parent)
        }
    }

    private func children(of session: AgentSession) -> [AgentSession] {
        agents.sessions.filter { $0.parentSessionID == session.id }
    }

    private func notInstalledCard(_ kind: AgentKind) -> some View {
        HStack(spacing: 12) {
            Image(systemName: kind.symbol)
                .font(.system(size: 16, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .frame(width: 26)
            Text(kind.displayName)
                .font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 6)
            Text("Not installed")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.4))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(.white.opacity(0.45))
        .background(.white.opacity(0.04), in: .rect(cornerRadius: 16))
    }

    // MARK: - Usage limits

    private func usagePanel(_ usage: AgentUsage) -> some View {
        VStack(spacing: 9) {
            usageBar("5-hour", percent: usage.fiveHourUsedPercent, reset: usage.fiveHourResetsAt)
            usageBar("Weekly", percent: usage.sevenDayUsedPercent, reset: usage.sevenDayResetsAt)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
    }

    private func usageBar(_ label: String, percent: Double, reset: Date?) -> some View {
        let clamped = min(max(percent, 0), 100)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Text(label).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                Spacer(minLength: 4)
                Text("\(Int(clamped))%").font(.system(size: 11)).monospacedDigit().foregroundStyle(.white.opacity(0.6))
                if let reset { Text("· \(resetString(reset))").font(.system(size: 10)).foregroundStyle(.white.opacity(0.4)) }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.12))
                    Capsule().fill(usageColor(clamped)).frame(width: max(2, geo.size.width * clamped / 100))
                }
            }
            .frame(height: 5)
        }
    }

    private func usageColor(_ percent: Double) -> Color {
        switch percent {
        case ..<70: return .green
        case ..<90: return .orange
        default: return .red
        }
    }

    private func resetString(_ date: Date) -> String {
        let seconds = Int(date.timeIntervalSinceNow)
        guard seconds > 0 else { return "resetting" }
        if seconds < 3600 { return "resets in \(seconds / 60)m" }
        if seconds < 86400 { return "resets in \(seconds / 3600)h" }
        return "resets in \(seconds / 86400)d"
    }

    private func enableCard(_ kind: AgentKind) -> some View {
        HStack(spacing: 12) {
            Image(systemName: kind.symbol)
                .font(.system(size: 16, weight: .semibold))
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
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
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
