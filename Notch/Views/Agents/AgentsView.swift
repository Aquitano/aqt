import SwiftUI

/// The Agents tab: live sessions (tap to jump to the terminal) plus Claude usage
/// limits. Per-agent enable/install lives in the Settings window, so this view
/// stays focused on what's actually running.
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
                if agents.sessions.isEmpty {
                    emptyState
                }
            }
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { agents.refresh() }
    }

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

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "terminal")
                .font(.system(size: 22))
                .foregroundStyle(.white.opacity(0.4))
            Text("No active agents")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
            Text("Enable an agent in Settings, then run it in a project to see it here.")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.45))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }
}
