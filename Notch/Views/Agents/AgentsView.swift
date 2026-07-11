import SwiftUI

/// The Agents tab: live sessions (tap to jump to the terminal) plus Claude usage
/// limits. Per-agent enable/install lives in the Settings window, so this view
/// stays focused on what's actually running.
struct AgentsView: View {
    @EnvironmentObject private var agents: AgentManager
    @State private var selectedPermissionId: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            content
        }
    }

    private var content: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 10) {
                if let usage = agents.usage {
                    usagePanel(usage)
                }
                if let pending = selectedPermission {
                    permissionCard(pending)
                }
                ForEach(sessionRows) { row in
                    AgentRowView(
                        session: row.session,
                        onJump: {
                            if let requestId = row.session.permissionRequestId,
                               agents.permissionRequests[requestId] != nil {
                                selectedPermissionId = requestId
                            } else {
                                agents.jumpToTerminal(row.session)
                            }
                        }
                    )
                        .padding(.leading, CGFloat(row.depth) * 22)
                        .opacity(row.depth > 0 ? 0.92 : 1)
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
        .onAppear { selectBestPermissionIfNeeded() }
        .onChange(of: permissionIds) { _, _ in selectBestPermissionIfNeeded() }
    }

    private var permissionIds: [String] { agents.permissionRequests.keys.sorted() }

    private var selectedPermission: PendingAgentPermission? {
        selectedPermissionId.flatMap { agents.permissionRequests[$0] }
    }

    private func selectBestPermissionIfNeeded() {
        if let selectedPermissionId, agents.permissionRequests[selectedPermissionId] != nil { return }
        selectedPermissionId = agents.permissionRequests.values.sorted(by: permissionOrder).first?.id
    }

    private func permissionOrder(_ lhs: PendingAgentPermission, _ rhs: PendingAgentPermission) -> Bool {
        let lhsUrgent = lhs.risk.level == .high || lhs.risk.level == .unknown
        let rhsUrgent = rhs.risk.level == .high || rhs.risk.level == .unknown
        if lhsUrgent != rhsUrgent { return lhsUrgent }
        return lhs.receivedAt < rhs.receivedAt
    }

    private func permissionCard(_ pending: PendingAgentPermission) -> some View {
        let session = agents.sessions.first { $0.id == pending.sessionId }
        return AgentPermissionCard(
            pending: pending,
            session: session,
            onApprove: { agents.respondToPermission(requestId: pending.id, decision: .allow) },
            onDeny: { agents.respondToPermission(requestId: pending.id, decision: .deny) },
            onJump: {
                if let session { agents.jumpToTerminal(session) }
                else { agents.jumpToTerminal(pending) }
            },
            onCopy: { agents.copyPermissionSummary(pending, session: session) }
        )
    }

    private struct Row: Identifiable {
        let session: AgentSession
        let depth: Int
        var id: String { session.id }
    }

    /// The session forest flattened depth-first, so a sub-agent that spawns its own
    /// sub-session (a grandchild, which OpenCode supports) still renders — indented
    /// by depth — instead of vanishing between the top-level and direct-child passes.
    private var sessionRows: [Row] {
        let sessions = agents.sessions
        let ids = Set(sessions.map(\.id))
        let childrenByParent = Dictionary(
            grouping: sessions.filter { ($0.parentSessionID).map(ids.contains) ?? false },
            by: { $0.parentSessionID! }
        )
        // Roots: no parent, or a parent that isn't currently shown.
        let roots = sessions.filter { session in
            guard let parent = session.parentSessionID else { return true }
            return !ids.contains(parent)
        }

        var rows: [Row] = []
        var visited = Set<String>()
        func visit(_ session: AgentSession, depth: Int) {
            guard visited.insert(session.id).inserted else { return } // guard against parent cycles
            rows.append(Row(session: session, depth: depth))
            for child in childrenByParent[session.id] ?? [] { visit(child, depth: depth + 1) }
        }
        for root in roots { visit(root, depth: 0) }
        return rows
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
            PixelIcon(systemName: "terminal", size: 22,
                      tint: .white.opacity(0.4))
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
