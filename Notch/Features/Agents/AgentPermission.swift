import Foundation

enum AgentPermissionOperation: String, Codable, Equatable, Sendable {
    case read
    case write
    case edit
    case delete
    case move
    case execute
    case network
    case install
    case permissionChange
    case unknown

    var canModify: Bool {
        switch self {
        case .write, .edit, .delete, .move, .execute, .install, .permissionChange:
            return true
        case .read, .network, .unknown:
            return false
        }
    }
}

enum AgentPermissionPathSource: String, Codable, Equatable, Sendable {
    case explicit
    case inferredFromCommand
}

struct AgentPermissionRequest: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    var schemaVersion: Int
    var requestId: String
    var toolName: String?
    var operation: AgentPermissionOperation
    var command: String?
    var paths: [String]
    var pathSource: AgentPermissionPathSource
    var url: String?
    var description: String?
    var rawInputSummary: String?
    var requestedAt: Date
    var replyDeadline: Date
    var commandTruncated: Bool
    var inputTruncated: Bool
}

enum AgentPermissionWireValidator {
    static func validated(
        _ request: AgentPermissionRequest?, matchingRequestId requestId: String
    ) -> AgentPermissionRequest? {
        guard let request,
              request.schemaVersion == AgentPermissionRequest.currentSchemaVersion,
              request.requestId == requestId,
              !requestId.isEmpty,
              request.replyDeadline >= request.requestedAt,
              request.replyDeadline.timeIntervalSince(request.requestedAt) <= 130,
              request.paths.count <= AgentPermissionLimits.maximumPathCount,
              valid(request.toolName, maximumBytes: 128),
              valid(request.command, maximumBytes: AgentPermissionLimits.maximumCommandBytes),
              request.paths.allSatisfy({ valid($0, maximumBytes: AgentPermissionLimits.maximumStringBytes) }),
              valid(request.url), valid(request.description), valid(request.rawInputSummary)
        else { return nil }
        return request
    }

    private static func valid(
        _ value: String?, maximumBytes: Int = AgentPermissionLimits.maximumStringBytes
    ) -> Bool {
        guard let value else { return true }
        return value.utf8.count <= maximumBytes
            && value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
}

enum AgentPermissionLimits {
    static let maximumCommandBytes = 8 * 1024
    static let maximumStringBytes = 2 * 1024
    static let maximumPathCount = 16
    static let maximumEnvelopeBytes = 64 * 1024
}

/// Extracts only security-relevant allowlisted values from hook input. Raw JSON
/// is never retained, and every value is cleaned and bounded before it reaches
/// the wire envelope.
enum AgentPermissionExtractor {
    private static let pathKeys = [
        "file_path", "path", "paths", "directory", "destination",
        "destination_path", "target_path", "source", "source_path",
        "old_path", "new_path"
    ]

    static func makeRequest(
        toolName: String?,
        input: [String: Any]?,
        requestId: String,
        requestedAt: Date = Date(),
        replyWindow: TimeInterval = 120
    ) -> AgentPermissionRequest {
        let cleanedTool = clipped(toolName, maximumBytes: 128).value
        let commandResult = clipped(input?["command"] as? String,
                                    maximumBytes: AgentPermissionLimits.maximumCommandBytes)
        let descriptionResult = clipped(input?["description"] as? String)
        let urlResult = clipped(input?["url"] as? String)
        let explicitPaths = extractExplicitPaths(input)
        let shellPaths = explicitPaths.values.isEmpty
            ? ShellPermissionAnalysis.possiblePaths(in: commandResult.value)
            : []
        let paths = explicitPaths.values.isEmpty ? shellPaths : explicitPaths.values
        let pathSource: AgentPermissionPathSource = explicitPaths.values.isEmpty && !shellPaths.isEmpty
            ? .inferredFromCommand
            : .explicit

        let operation = operation(toolName: cleanedTool, command: commandResult.value)
        let summary = rawSummary(
            command: commandResult.value,
            paths: paths,
            url: urlResult.value,
            description: descriptionResult.value
        )
        return AgentPermissionRequest(
            schemaVersion: AgentPermissionRequest.currentSchemaVersion,
            requestId: clipped(requestId, maximumBytes: 128).value ?? "unknown",
            toolName: cleanedTool,
            operation: operation,
            command: commandResult.value,
            paths: paths,
            pathSource: pathSource,
            url: urlResult.value,
            description: descriptionResult.value,
            rawInputSummary: summary,
            requestedAt: requestedAt,
            replyDeadline: requestedAt.addingTimeInterval(replyWindow),
            commandTruncated: commandResult.truncated,
            inputTruncated: explicitPaths.truncated || descriptionResult.truncated || urlResult.truncated
        )
    }

    private static func extractExplicitPaths(_ input: [String: Any]?) -> (values: [String], truncated: Bool) {
        guard let input else { return ([], false) }
        var values: [String] = []
        var truncated = false
        for key in pathKeys {
            let candidates: [String]
            if let value = input[key] as? String {
                candidates = [value]
            } else if let array = input[key] as? [String] {
                candidates = array
            } else {
                continue
            }
            for candidate in candidates {
                if values.count == AgentPermissionLimits.maximumPathCount {
                    truncated = true
                    break
                }
                let result = clipped(candidate)
                truncated = truncated || result.truncated
                if let value = result.value, !values.contains(value) { values.append(value) }
            }
        }
        return (values, truncated)
    }

    private static func operation(toolName: String?, command: String?) -> AgentPermissionOperation {
        let tool = toolName?.lowercased() ?? ""
        switch tool {
        case "read", "notebookread", "view", "cat", "grep", "glob", "ls", "search": return .read
        case "write", "create": return .write
        case "edit", "multiedit", "notebookedit", "apply_patch", "str_replace_editor", "update": return .edit
        case "delete", "remove": return .delete
        case "move", "rename": return .move
        case "webfetch", "websearch", "fetch", "browser": return .network
        case "bash", "shell", "execute", "terminal": return ShellPermissionAnalysis.operation(for: command)
        default: return .unknown
        }
    }

    private static func rawSummary(
        command: String?, paths: [String], url: String?, description: String?
    ) -> String? {
        var fields: [String] = []
        if command != nil { fields.append("command") }
        if !paths.isEmpty { fields.append(paths.count == 1 ? "1 path" : "\(paths.count) paths") }
        if url != nil { fields.append("URL") }
        if description != nil { fields.append("description") }
        return fields.isEmpty ? nil : fields.joined(separator: ", ")
    }

    private static func clipped(
        _ value: String?, maximumBytes: Int = AgentPermissionLimits.maximumStringBytes
    ) -> (value: String?, truncated: Bool) {
        guard let value else { return (nil, false) }
        let cleaned = value.unicodeScalars.map { scalar -> String in
            CharacterSet.controlCharacters.contains(scalar) ? " " : String(scalar)
        }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return (nil, false) }
        let bytes = Array(cleaned.utf8)
        guard bytes.count > maximumBytes else { return (cleaned, false) }
        var end = maximumBytes
        while end > 0 && (bytes[end] & 0b1100_0000) == 0b1000_0000 { end -= 1 }
        return (String(decoding: bytes[..<end], as: UTF8.self), true)
    }
}

private enum ShellPermissionAnalysis {
    static func operation(for command: String?) -> AgentPermissionOperation {
        guard let command = command?.lowercased(), !command.isEmpty else { return .unknown }
        if command.range(of: #"(^|[;&|]\s*)(rm|rmdir|shred)\s"#, options: .regularExpression) != nil {
            return .delete
        }
        if command.range(of: #"(^|[;&|]\s*)(mv|rename)\s"#, options: .regularExpression) != nil {
            return .move
        }
        if command.range(of: #"(^|[;&|]\s*)(chmod|chown|chgrp)\s"#, options: .regularExpression) != nil {
            return .permissionChange
        }
        if command.range(of: #"\b(npm|pnpm|yarn|pip|pip3|brew|gem|cargo)\s+(add|install)\b"#,
                         options: .regularExpression) != nil {
            return .install
        }
        if command.range(of: #"\b(curl|wget|ssh|scp|rsync)\b"#, options: .regularExpression) != nil {
            return .network
        }
        return .execute
    }

    static func possiblePaths(in command: String?) -> [String] {
        guard let command else { return [] }
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ";|&<>"))
        var result: [String] = []
        for raw in command.components(separatedBy: separators) {
            var token = raw.trimmingCharacters(in: CharacterSet(charactersIn: "'\"`()[],"))
            while token.hasSuffix(":") { token.removeLast() }
            guard !token.isEmpty, !token.contains("://"),
                  token.hasPrefix("/") || token.hasPrefix("./") || token.hasPrefix("../")
                    || token.hasPrefix("~/") || token.contains("/") else { continue }
            guard !result.contains(token) else { continue }
            result.append(token)
            if result.count == AgentPermissionLimits.maximumPathCount { break }
        }
        return result
    }
}

enum AgentPermissionPathScope: String, Codable, Equatable, Sendable {
    case project
    case outsideProject
    case home
    case system
    case removableVolume
    case unknown
}

struct AgentPermissionPathAssessment: Equatable, Sendable {
    let original: String
    let normalized: String?
    let projectRelativePath: String?
    let scope: AgentPermissionPathScope
    let source: AgentPermissionPathSource
    let hasLexicalTraversal: Bool
}

enum AgentPermissionPathNormalizer {
    static func assess(
        _ paths: [String],
        source: AgentPermissionPathSource,
        cwd: String?,
        homeDirectory: String = NSHomeDirectory()
    ) -> [AgentPermissionPathAssessment] {
        paths.map { assess($0, source: source, cwd: cwd, homeDirectory: homeDirectory) }
    }

    static func assess(
        _ path: String,
        source: AgentPermissionPathSource,
        cwd: String?,
        homeDirectory: String
    ) -> AgentPermissionPathAssessment {
        let hasTraversal = path.split(separator: "/", omittingEmptySubsequences: false).contains("..")
        guard !hasAmbiguousSyntax(path), let cwd, cwd.hasPrefix("/") else {
            return assessment(path, nil, nil, .unknown, source, hasTraversal)
        }
        let expanded: String
        if path == "~" { expanded = homeDirectory }
        else if path.hasPrefix("~/") { expanded = homeDirectory + String(path.dropFirst()) }
        else if path.hasPrefix("/") { expanded = path }
        else { expanded = cwd + "/" + path }

        let normalized = lexicalStandardize(expanded)
        let project = lexicalStandardize(cwd)
        let home = lexicalStandardize(homeDirectory)
        let scope: AgentPermissionPathScope
        if isSystemPath(normalized) { scope = .system }
        else if normalized == "/Volumes" || normalized.hasPrefix("/Volumes/") { scope = .removableVolume }
        else if isInside(normalized, root: project) { scope = .project }
        else if isInside(normalized, root: home) { scope = .home }
        else { scope = .outsideProject }
        let relative = scope == .project
            ? (normalized == project ? "." : String(normalized.dropFirst(project.count + 1)))
            : nil
        return assessment(path, normalized, relative, scope, source, hasTraversal)
    }

    private static func assessment(
        _ original: String, _ normalized: String?, _ relative: String?,
        _ scope: AgentPermissionPathScope, _ source: AgentPermissionPathSource,
        _ traversal: Bool
    ) -> AgentPermissionPathAssessment {
        AgentPermissionPathAssessment(
            original: original, normalized: normalized, projectRelativePath: relative,
            scope: scope, source: source, hasLexicalTraversal: traversal
        )
    }

    private static func hasAmbiguousSyntax(_ path: String) -> Bool {
        path.contains("$") || path.contains("`") || path.contains("*")
            || path.contains("?") || path.contains("{") || path.contains("}")
    }

    private static func lexicalStandardize(_ path: String) -> String {
        var components: [Substring] = []
        for component in path.split(separator: "/") {
            if component == "." { continue }
            if component == ".." { if !components.isEmpty { components.removeLast() }; continue }
            components.append(component)
        }
        return "/" + components.joined(separator: "/")
    }

    private static func isInside(_ path: String, root: String) -> Bool {
        path == root || path.hasPrefix(root == "/" ? "/" : root + "/")
    }

    private static func isSystemPath(_ path: String) -> Bool {
        ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/private/etc"]
            .contains { path == $0 || path.hasPrefix($0 + "/") }
    }
}

enum AgentPermissionRiskLevel: String, Codable, Equatable, Sendable {
    case low
    case medium
    case high
    case unknown
}

enum AgentPermissionRiskReason: String, Codable, Equatable, Hashable, Sendable {
    case missingEvidence
    case truncatedInput
    case unsupportedTool
    case recursiveDeletion
    case privilegeEscalation
    case systemWrite
    case outsideProjectWrite
    case sensitiveDataMutation
    case downloadAndExecute
    case broadPermissionChange
    case networkAccess
    case packageInstallation
    case processTermination
    case gitPush
    case destructiveProjectChange
    case userConfigurationWrite
    case shellAmbiguity
    case ambiguousPath
    case explicitProjectRead
    case explicitProjectWrite
    case knownLocalBuild
}

struct AgentPermissionRisk: Equatable, Sendable {
    let level: AgentPermissionRiskLevel
    let reasons: [AgentPermissionRiskReason]
}

enum AgentPermissionDecision: String, Equatable, Sendable {
    case allow
    case deny
}

enum AgentPermissionRequestState: Equatable, Sendable {
    case pending
    case responding(AgentPermissionDecision)
    case approved
    case denied
    case deliveryFailed
    case expired
}

enum AgentPermissionStateEvent: Equatable, Sendable {
    case respond(AgentPermissionDecision)
    case delivered
    case deliveryFailed
    case expire
}

enum AgentPermissionStateMachine {
    static func transition(
        from state: AgentPermissionRequestState,
        event: AgentPermissionStateEvent
    ) -> AgentPermissionRequestState? {
        switch (state, event) {
        case (.pending, .respond(let decision)):
            return .responding(decision)
        case (.responding(.allow), .delivered):
            return .approved
        case (.responding(.deny), .delivered):
            return .denied
        case (.responding, .deliveryFailed):
            return .deliveryFailed
        case (.pending, .expire), (.responding, .expire), (.deliveryFailed, .expire):
            return .expired
        default:
            return nil
        }
    }
}

struct PendingAgentPermission: Identifiable, Equatable, Sendable {
    let id: String
    let kind: AgentKind
    let sessionId: String?
    let cwd: String?
    let pid: pid_t
    let request: AgentPermissionRequest?
    let risk: AgentPermissionRisk
    let receivedAt: Date
    let replyDeadline: Date
    let canRespond: Bool
    var state: AgentPermissionRequestState

    func isActionable(at date: Date) -> Bool {
        canRespond && state == .pending && date < replyDeadline
    }
}

enum AgentPermissionAuditSummary {
    static func make(pending: PendingAgentPermission, session: AgentSession?) -> String {
        let request = pending.request
        var lines = [
            "Agent: \(pending.kind.displayName)",
            "Project: \(session?.project ?? agentProjectName(pending.cwd))"
        ]
        if let branch = session?.gitBranch { lines.append("Branch: \(branch)") }
        if let terminal = session?.terminalName { lines.append("Terminal: \(terminal)") }
        if let cwd = pending.cwd { lines.append("Working directory: \(cwd)") }
        if let tool = request?.toolName { lines.append("Tool: \(tool)") }
        lines.append("Operation: \(request?.operation.rawValue ?? "unknown")")
        if let command = request?.command {
            lines.append("Command: \(command)\(request?.commandTruncated == true ? " [truncated]" : "")")
        }
        if let url = request?.url { lines.append("URL: \(url)") }
        if let request, !request.paths.isEmpty {
            lines.append(request.pathSource == .explicit ? "Affected paths:" : "Possible paths:")
            lines.append(contentsOf: request.paths.map { "- \($0)" })
        }
        lines.append("Risk: \(pending.risk.level.rawValue)")
        lines.append("Reasons: \(pending.risk.reasons.map(\.rawValue).joined(separator: ", "))")
        lines.append("Requested: \((request?.requestedAt ?? pending.receivedAt).formatted(.iso8601))")
        lines.append("Actionable: \(pending.isActionable(at: Date()) ? "yes" : "no")")
        return lines.joined(separator: "\n")
    }
}

/// Advisory, deterministic classification. It never authorizes a request and
/// never reads the filesystem; the same structured evidence always yields the
/// same level and ordered reason codes.
enum PermissionRiskClassifier {
    static func classify(
        request: AgentPermissionRequest,
        cwd: String?,
        homeDirectory: String = NSHomeDirectory()
    ) -> AgentPermissionRisk {
        let assessments = AgentPermissionPathNormalizer.assess(
            request.paths, source: request.pathSource, cwd: cwd, homeDirectory: homeDirectory
        )
        let command = request.command?.lowercased() ?? ""
        var high: Set<AgentPermissionRiskReason> = []
        var medium: Set<AgentPermissionRiskReason> = []
        var low: Set<AgentPermissionRiskReason> = []

        if destructiveDeletion(command) { high.insert(.recursiveDeletion) }
        if command.range(of: #"(^|\s)(sudo|doas)\s"#, options: .regularExpression) != nil {
            high.insert(.privilegeEscalation)
        }
        if downloadAndExecute(command) { high.insert(.downloadAndExecute) }
        if broadPermissionChange(command) { high.insert(.broadPermissionChange) }

        if request.operation.canModify || request.operation == .network {
            if assessments.contains(where: { $0.scope == .system }) { high.insert(.systemWrite) }
            if assessments.contains(where: { $0.scope == .outsideProject || $0.scope == .removableVolume }) {
                high.insert(.outsideProjectWrite)
            }
            if assessments.contains(where: sensitivePath) { high.insert(.sensitiveDataMutation) }
            if assessments.contains(where: { $0.scope == .home }) { medium.insert(.userConfigurationWrite) }
        }
        if assessments.contains(where: { $0.scope == .unknown || $0.hasLexicalTraversal }) {
            medium.insert(.ambiguousPath)
        }

        if request.operation == .network || request.url != nil || networkCommand(command) {
            medium.insert(.networkAccess)
        }
        if request.operation == .install { medium.insert(.packageInstallation) }
        if command.range(of: #"(^|[;&|]\s*)(kill|killall|pkill)\s"#, options: .regularExpression) != nil {
            medium.insert(.processTermination)
        }
        if command.range(of: #"\bgit\s+push\b"#, options: .regularExpression) != nil { medium.insert(.gitPush) }
        if request.operation == .delete || request.operation == .move {
            medium.insert(.destructiveProjectChange)
        }
        if hasShellAmbiguity(command) { medium.insert(.shellAmbiguity) }

        let explicitProjectPaths = !assessments.isEmpty
            && assessments.allSatisfy { $0.scope == .project && $0.source == .explicit && !$0.hasLexicalTraversal }
        if request.operation == .read && explicitProjectPaths { low.insert(.explicitProjectRead) }
        if (request.operation == .write || request.operation == .edit) && explicitProjectPaths {
            low.insert(.explicitProjectWrite)
        }
        if knownLocalBuild(command), medium.isEmpty { low.insert(.knownLocalBuild) }

        if !high.isEmpty { return risk(.high, high) }
        if request.commandTruncated || request.inputTruncated {
            return risk(.unknown, [.truncatedInput])
        }
        if !medium.isEmpty { return risk(.medium, medium) }
        if !low.isEmpty { return risk(.low, low) }
        if request.operation == .unknown {
            let tool = request.toolName?.lowercased()
            let knownShellWithoutInput = tool.map {
                ["bash", "shell", "execute", "terminal"].contains($0)
            } ?? false
            return risk(.unknown, [knownShellWithoutInput ? .missingEvidence : .unsupportedTool])
        }
        return risk(.unknown, [.missingEvidence])
    }

    private static func risk(
        _ level: AgentPermissionRiskLevel, _ reasons: Set<AgentPermissionRiskReason>
    ) -> AgentPermissionRisk {
        AgentPermissionRisk(level: level, reasons: reasons.sorted { $0.rawValue < $1.rawValue })
    }

    private static func destructiveDeletion(_ command: String) -> Bool {
        command.range(of: #"\brm\s+[^\n;&|]*(?:-[a-z]*[rf][a-z]*|--recursive|--force)"#,
                      options: .regularExpression) != nil
            || command.contains("diskutil erase") || command.contains("diskutil partition")
            || command.contains("mkfs.")
    }

    private static func downloadAndExecute(_ command: String) -> Bool {
        command.range(of: #"\b(curl|wget)\b[^\n]*(\||>)\s*(sh|bash|zsh|python|perl)\b"#,
                      options: .regularExpression) != nil
            || command.range(of: #"\b(base64|openssl)\b[^\n]*\|\s*(sh|bash|zsh|python|perl)\b"#,
                             options: .regularExpression) != nil
    }

    private static func broadPermissionChange(_ command: String) -> Bool {
        command.range(of: #"\bchmod\s+(?:-[rR]\s+)?(?:777|a\+[rwx]*[wx][rwx]*)\b"#,
                      options: .regularExpression) != nil
    }

    private static func networkCommand(_ command: String) -> Bool {
        command.range(of: #"\b(curl|wget|ssh|scp|rsync)\b"#, options: .regularExpression) != nil
    }

    private static func hasShellAmbiguity(_ command: String) -> Bool {
        guard !command.isEmpty else { return false }
        return command.contains("|") || command.contains(">") || command.contains("<")
            || command.contains(";") || command.contains("&&") || command.contains("||")
            || command.contains("$") || command.contains("`")
            || command.contains("*") || command.contains("?") || command.contains("<<")
    }

    private static func knownLocalBuild(_ command: String) -> Bool {
        ["xcodebuild ", "swift test", "swift build", "cargo test", "cargo build",
         "npm test", "pnpm test", "yarn test", "gradle test", "./gradlew test"]
            .contains { command == $0.trimmingCharacters(in: .whitespaces) || command.hasPrefix($0) }
    }

    private static func sensitivePath(_ assessment: AgentPermissionPathAssessment) -> Bool {
        guard let path = assessment.normalized?.lowercased() else { return false }
        return path.contains("/.ssh/") || path.hasSuffix("/.ssh")
            || path.contains("/.aws/") || path.hasSuffix("/.aws")
            || path.contains("/.gnupg/") || path.hasSuffix("/.gnupg")
            || path.contains("/keychains/") || path.hasSuffix(".pem")
            || path.hasSuffix(".key")
    }
}
