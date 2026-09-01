import SwiftUI

struct AgentPermissionCard: View {
    let pending: PendingAgentPermission
    let session: AgentSession?
    let onApprove: () -> Void
    let onDeny: () -> Void
    let onJump: () -> Void
    let onCopy: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: 12) {
                header(now: context.date)
                metadata
                evidence
                reasons
                actions(now: context.date)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 16))
            .accessibilityElement(children: .contain)
        }
    }

    private func header(now: Date) -> some View {
        HStack(spacing: 8) {
            PixelIcon(systemName: "exclamationmark.bubble.fill", size: 17, tint: riskColor)
            VStack(alignment: .leading, spacing: 1) {
                Text("Permission request")
                    .font(.system(size: 13, weight: .bold))
                Text("\(pending.kind.displayName) · \(session?.project ?? agentProjectName(pending.cwd))")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.white.opacity(0.5))
            }
            Spacer(minLength: 6)
            Text(pending.risk.level.rawValue.capitalized)
                .font(.system(size: 10, weight: .bold))
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(riskColor.opacity(0.18), in: .capsule)
                .foregroundStyle(riskColor)
            Text(deadlineText(now))
                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                .foregroundStyle(.white.opacity(0.5))
        }
    }

    private var metadata: some View {
        Grid(alignment: .leading, horizontalSpacing: 9, verticalSpacing: 3) {
            metadataRow("Tool", pending.request?.toolName ?? "Unknown")
            metadataRow("Operation", pending.request?.operation.rawValue.capitalized ?? "Unknown")
            if let branch = session?.gitBranch { metadataRow("Branch", branch) }
            if let terminal = session?.terminalName { metadataRow("Terminal", terminal) }
            if let cwd = pending.cwd { metadataRow("Directory", cwd) }
        }
        .font(.system(size: 10))
        .textSelection(.enabled)
    }

    private func metadataRow(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.white.opacity(0.38))
            Text(value).foregroundStyle(.white.opacity(0.72)).lineLimit(1).truncationMode(.middle)
        }
    }

    @ViewBuilder
    private var evidence: some View {
        if let command = pending.request?.command {
            VStack(alignment: .leading, spacing: 4) {
                Text(pending.request?.commandTruncated == true ? "COMMAND · TRUNCATED" : "COMMAND")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(0.38))
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(command)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.82))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .padding(8)
                .background(.black.opacity(0.28), in: .rect(cornerRadius: 8))
            }
        }
        if let request = pending.request, !request.paths.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(request.pathSource == .explicit ? "AFFECTED PATHS" : "POSSIBLE PATHS")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(0.38))
                ForEach(Array(request.paths.enumerated()), id: \.offset) { _, path in
                    Text(path)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private var reasons: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(pending.risk.reasons, id: \.self) { reason in
                Text("• \(reason.label)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.white.opacity(0.58))
            }
        }
        .accessibilityLabel("Risk reasons: \(pending.risk.reasons.map(\.label).joined(separator: ", "))")
    }

    private func actions(now: Date) -> some View {
        HStack(spacing: 7) {
            Button("Jump to Terminal", action: onJump).buttonStyle(.bordered).controlSize(.small)
            Button("Copy Summary", action: onCopy).buttonStyle(.bordered).controlSize(.small)
            Spacer(minLength: 4)
            if case .responding = pending.state { ProgressView().controlSize(.small) }
            Button("Deny", action: onDeny)
                .buttonStyle(.bordered).controlSize(.small).tint(.red)
                .disabled(!pending.isActionable(at: now))
            Button("Approve once", action: onApprove)
                .buttonStyle(.borderedProminent).controlSize(.small).tint(.green)
                .disabled(!pending.isActionable(at: now))
        }
        .overlay(alignment: .topTrailing) {
            if let statusText {
                Text(statusText)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(statusColor)
                    .offset(y: -13)
            }
        }
    }

    private func deadlineText(_ now: Date) -> String {
        if pending.state == .expired || now >= pending.replyDeadline { return "Continue in Terminal" }
        return "\(max(0, Int(pending.replyDeadline.timeIntervalSince(now))))s"
    }

    private var statusText: String? {
        switch pending.state {
        case .pending: return nil
        case .responding: return "Sending…"
        case .approved: return "Approved once"
        case .denied: return "Denied"
        case .deliveryFailed: return "Delivery failed · Continue in Terminal"
        case .expired: return "Continue in Terminal"
        }
    }

    private var statusColor: Color {
        switch pending.state {
        case .approved: return .green
        case .denied, .deliveryFailed: return .red
        default: return .white.opacity(0.5)
        }
    }

    private var riskColor: Color {
        switch pending.risk.level {
        case .low: return .green
        case .medium: return .orange
        case .high: return .red
        case .unknown: return .yellow
        }
    }
}

private extension AgentPermissionRiskReason {
    var label: String {
        switch self {
        case .missingEvidence: return "The request does not include enough structured evidence"
        case .truncatedInput: return "Command or input was truncated"
        case .unsupportedTool: return "The tool or input structure is not recognized"
        case .recursiveDeletion: return "Deletes files recursively or forcefully"
        case .privilegeEscalation: return "Uses administrator privileges"
        case .systemWrite: return "Writes to a system location"
        case .outsideProjectWrite: return "Writes outside the project"
        case .sensitiveDataMutation: return "Can modify credentials or sensitive configuration"
        case .downloadAndExecute: return "Downloads and executes code"
        case .broadPermissionChange: return "Broadly grants write or execute permission"
        case .networkAccess: return "Makes a network request"
        case .packageInstallation: return "Installs a package"
        case .processTermination: return "Terminates a process"
        case .gitPush: return "Pushes changes to a remote repository"
        case .destructiveProjectChange: return "Moves or deletes project content"
        case .userConfigurationWrite: return "Writes to user configuration"
        case .shellAmbiguity: return "Shell syntax makes the final effect ambiguous"
        case .ambiguousPath: return "A path cannot be verified lexically"
        case .explicitProjectRead: return "Reads explicit paths inside the project"
        case .explicitProjectWrite: return "Writes explicit paths inside the project"
        case .knownLocalBuild: return "Runs a known local build or test command"
        }
    }
}
