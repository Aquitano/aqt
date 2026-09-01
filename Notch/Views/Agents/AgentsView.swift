import SwiftUI

/// The Agents tab: live sessions (tap to jump to the terminal) plus Claude usage
/// limits. Sessions quiet for a while collapse to one-line rows under an "idle"
/// rule, and the scroll edges fade so overflow reads as scrollable instead of
/// clipped. Per-agent enable/install lives in the Settings window, so this view
/// stays focused on what's actually running.
struct AgentsView: View {
    @Environment(AgentManager.self) private var agents
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var selectedPermissionId: String?
    @State private var scrollEdges = ScrollEdges()

    /// Quiet this long (and not waiting on the user) collapses a session.
    private static let idleCollapseAfter: TimeInterval = 10 * 60

    private struct ScrollEdges: Equatable {
        var top = false
        var bottom = false
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            content
        }
    }

    private var content: some View {
        let rows = sessionRows
        return ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 10) {
                if let usage = agents.usage {
                    usagePanel(usage)
                }
                if let pending = selectedPermission {
                    permissionCard(pending)
                }
                ForEach(rows.active) { row in
                    AgentRowView(session: row.session,
                                 onJump: { jump(row.session) },
                                 onQuit: { agents.terminate(row.session) })
                        .padding(.leading, CGFloat(row.depth) * 22)
                        .opacity(row.depth > 0 ? 0.92 : 1)
                }
                if !rows.collapsed.isEmpty {
                    if !rows.active.isEmpty {
                        idleDivider
                    }
                    ForEach(rows.collapsed) { session in
                        AgentRowView(session: session, collapsed: true,
                                     onJump: { jump(session) },
                                     onQuit: { agents.terminate(session) })
                    }
                }
                if agents.sessions.isEmpty {
                    emptyState
                }
            }
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .top)
            .animation(NotchAnimation.morph(reduceMotion: reduceMotion),
                       value: rows.collapsed.map(\.id))
        }
        .onScrollGeometryChange(for: ScrollEdges.self) { geometry in
            let overflow = geometry.contentSize.height - geometry.containerSize.height
            return ScrollEdges(
                top: geometry.contentOffset.y > 2,
                bottom: overflow > 2 && geometry.contentOffset.y < overflow - 2
            )
        } action: { _, edges in
            scrollEdges = edges
        }
        .mask(edgeFadeMask)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { agents.refresh() }
        .onAppear { selectBestPermissionIfNeeded() }
        .onChange(of: permissionIds) { _, _ in selectBestPermissionIfNeeded() }
    }

    private func jump(_ session: AgentSession) {
        if let requestId = session.permissionRequestId,
           agents.permissionRequests[requestId] != nil {
            selectedPermissionId = requestId
        } else {
            agents.jumpToTerminal(session)
        }
    }

    /// Soft fades where content continues past the visible edge — the standard
    /// "there's more, scroll" affordance without a scrollbar.
    private var edgeFadeMask: some View {
        VStack(spacing: 0) {
            LinearGradient(
                colors: [.black.opacity(scrollEdges.top ? 0 : 1), .black],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 16)
            Rectangle().fill(.black)
            LinearGradient(
                colors: [.black, .black.opacity(scrollEdges.bottom ? 0 : 1)],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 22)
        }
        .animation(.easeOut(duration: 0.18), value: scrollEdges)
    }

    private var idleDivider: some View {
        HStack(spacing: 8) {
            dividerLine
            Text("idle")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white.opacity(0.35))
            dividerLine
        }
        .padding(.horizontal, 4)
        .accessibilityHidden(true)
    }

    private var dividerLine: some View {
        Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
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

    private struct Rows {
        var active: [Row] = []
        var collapsed: [AgentSession] = []
    }

    /// The session forest flattened depth-first, so a sub-agent that spawns its own
    /// sub-session (a grandchild, which OpenCode supports) still renders — indented
    /// by depth — instead of vanishing between the top-level and direct-child passes.
    /// A root whose whole subtree has been quiet past the idle threshold moves to
    /// `collapsed` (one-line rows after the active cards); its stale sub-agent rows
    /// are folded into it.
    private var sessionRows: Rows {
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

        func isLongIdle(_ session: AgentSession) -> Bool {
            !session.status.isBusy
                && session.status != .needsAttention
                && session.permissionRequestId == nil
                && Date().timeIntervalSince(session.lastActivity) > Self.idleCollapseAfter
        }

        func subtreeIsLongIdle(_ session: AgentSession, visited: inout Set<String>) -> Bool {
            guard visited.insert(session.id).inserted else { return true } // guard against parent cycles
            guard isLongIdle(session) else { return false }
            return (childrenByParent[session.id] ?? [])
                .allSatisfy { subtreeIsLongIdle($0, visited: &visited) }
        }

        var rows = Rows()
        var visited = Set<String>()
        func visit(_ session: AgentSession, depth: Int) {
            guard visited.insert(session.id).inserted else { return } // guard against parent cycles
            rows.active.append(Row(session: session, depth: depth))
            for child in childrenByParent[session.id] ?? [] { visit(child, depth: depth + 1) }
        }
        for root in roots {
            var probe = visited
            if subtreeIsLongIdle(root, visited: &probe) {
                visited = probe
                rows.collapsed.append(root)
            } else {
                visit(root, depth: 0)
            }
        }
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
