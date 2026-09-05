import Foundation
import Testing
@testable import NotchCore

struct AgentPermissionExtractionTests {
    private let now = Date(timeIntervalSince1970: 1_000)

    @Test func bashExtractionPreservesCommandAndMarksPathsAsInferred() {
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "Bash",
            input: ["command": "rm -rf ./build/cache", "description": "Clean build"],
            requestId: "r1",
            requestedAt: now
        )

        #expect(request.schemaVersion == 1)
        #expect(request.command == "rm -rf ./build/cache")
        #expect(request.paths == ["./build/cache"])
        #expect(request.pathSource == .inferredFromCommand)
        #expect(request.operation == .delete)
        #expect(request.replyDeadline == now.addingTimeInterval(120))
    }

    @Test func editExtractionPrefersExplicitPathOverCommandGuessing() {
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "Edit",
            input: ["file_path": "Sources/App.swift", "command": "ignored/guess"],
            requestId: "r2"
        )

        #expect(request.operation == .edit)
        #expect(request.paths == ["Sources/App.swift"])
        #expect(request.pathSource == .explicit)
    }

    @Test func moveExtractionCollectsKnownSourceAndDestinationFields() {
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "Move",
            input: ["source_path": "old.txt", "destination_path": "new.txt"],
            requestId: "r3"
        )

        #expect(request.operation == .move)
        #expect(Set(request.paths) == ["old.txt", "new.txt"])
    }

    @Test func urlExtractionDoesNotRetainUnknownRawFields() {
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "WebFetch",
            input: ["url": "https://example.com", "authorization": "secret-token"],
            requestId: "r4"
        )

        #expect(request.operation == .network)
        #expect(request.url == "https://example.com")
        #expect(request.rawInputSummary == "URL")
        #expect(!(request.rawInputSummary?.contains("secret") ?? true))
    }

    @Test func unknownToolStaysUnknownEvenWithDescription() {
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "MysteryTool", input: ["description": "Do something"], requestId: "r5"
        )
        #expect(request.operation == .unknown)
    }

    @Test func commandIsByteCappedAtUTF8BoundaryAndMarkedTruncated() {
        let command = String(repeating: "é", count: AgentPermissionLimits.maximumCommandBytes)
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "Bash", input: ["command": command], requestId: "r6"
        )

        #expect(request.commandTruncated)
        #expect(request.command?.utf8.count ?? .max <= AgentPermissionLimits.maximumCommandBytes)
        #expect(request.command != nil)
    }

    @Test func controlCharactersAreRemovedFromForwardedValues() {
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "Write\u{0}",
            input: ["file_path": "Sources/\u{7}App.swift"],
            requestId: "r7"
        )

        #expect(request.toolName == "Write")
        #expect(request.paths == ["Sources/ App.swift"])
    }

    @Test func pathArrayIsCappedAndMarksInputTruncated() {
        let values = (0..<40).map { "Sources/\($0).swift" }
        let request = AgentPermissionExtractor.makeRequest(
            toolName: "Read", input: ["paths": values], requestId: "r8"
        )

        #expect(request.paths.count == AgentPermissionLimits.maximumPathCount)
        #expect(request.inputTruncated)
    }

    @Test func legacyEnvelopeWithoutPermissionPayloadStillDecodes() throws {
        let data = Data(#"{"agent":"claudeCode","hook":"Notification","message":"Waiting"}"#.utf8)
        let envelope = try JSONDecoder().decode(HookEnvelope.self, from: data)

        #expect(envelope.message == "Waiting")
        #expect(envelope.permission == nil)
    }

    @Test func permissionPayloadCodableRoundTrip() throws {
        let permission = AgentPermissionExtractor.makeRequest(
            toolName: "Write", input: ["file_path": "README.md"], requestId: "round-trip",
            requestedAt: now
        )
        let envelope = HookEnvelope(
            agent: AgentKind.claudeCode.rawValue, hook: "PermissionRequest",
            requestId: permission.requestId, permission: permission
        )

        let decoded = try JSONDecoder().decode(
            HookEnvelope.self, from: JSONEncoder().encode(envelope)
        )
        #expect(decoded.permission == permission)
    }

    @Test func maximumExtractedPermissionFitsEnvelopeCap() throws {
        let paths = (0..<AgentPermissionLimits.maximumPathCount).map {
            String(repeating: "p", count: AgentPermissionLimits.maximumStringBytes - 16) + "\($0)"
        }
        let permission = AgentPermissionExtractor.makeRequest(
            toolName: "Bash",
            input: [
                "command": String(repeating: "x", count: AgentPermissionLimits.maximumCommandBytes),
                "paths": paths,
                "description": String(repeating: "d", count: AgentPermissionLimits.maximumStringBytes)
            ],
            requestId: "bounded"
        )
        let envelope = HookEnvelope(
            agent: AgentKind.claudeCode.rawValue, hook: "PermissionRequest",
            requestId: permission.requestId, permission: permission
        )
        let encoded = try JSONEncoder().encode(envelope)
        #expect(encoded.count < AgentPermissionLimits.maximumEnvelopeBytes)
    }

    @Test func wireValidatorRejectsMismatchedIdUnknownSchemaAndOversizedData() {
        var permission = AgentPermissionExtractor.makeRequest(
            toolName: "Write", input: ["file_path": "README.md"], requestId: "request"
        )
        #expect(AgentPermissionWireValidator.validated(
            permission, matchingRequestId: "request"
        ) != nil)
        #expect(AgentPermissionWireValidator.validated(
            permission, matchingRequestId: "different"
        ) == nil)

        permission.schemaVersion = 99
        #expect(AgentPermissionWireValidator.validated(
            permission, matchingRequestId: "request"
        ) == nil)
        permission.schemaVersion = AgentPermissionRequest.currentSchemaVersion
        permission.command = String(repeating: "x", count: AgentPermissionLimits.maximumCommandBytes + 1)
        #expect(AgentPermissionWireValidator.validated(
            permission, matchingRequestId: "request"
        ) == nil)
    }
}

struct AgentPermissionPathTests {
    private let cwd = "/Users/test/Code/notch"
    private let home = "/Users/test"

    @Test func relativePathNormalizesInsideProject() {
        let result = AgentPermissionPathNormalizer.assess(
            "Sources/../Tests/AppTests.swift", source: .explicit, cwd: cwd, homeDirectory: home
        )
        #expect(result.normalized == "/Users/test/Code/notch/Tests/AppTests.swift")
        #expect(result.projectRelativePath == "Tests/AppTests.swift")
        #expect(result.scope == .project)
        #expect(result.hasLexicalTraversal)
    }

    @Test func traversalOutsideProjectIsClassifiedAsHome() {
        let result = AgentPermissionPathNormalizer.assess(
            "../../.ssh/config", source: .explicit, cwd: cwd, homeDirectory: home
        )
        #expect(result.scope == .home)
        #expect(result.normalized == "/Users/test/.ssh/config")
    }

    @Test func systemAndRemovableScopesTakePrecedence() {
        let results = AgentPermissionPathNormalizer.assess(
            ["/Library/LaunchDaemons/x.plist", "/Volumes/Backup/file"],
            source: .explicit, cwd: cwd, homeDirectory: home
        )
        #expect(results.map(\.scope) == [.system, .removableVolume])
    }

    @Test func homeExpansionIsLexical() {
        let result = AgentPermissionPathNormalizer.assess(
            "~/.config/tool", source: .explicit, cwd: cwd, homeDirectory: home
        )
        #expect(result.normalized == "/Users/test/.config/tool")
        #expect(result.scope == .home)
    }

    @Test func variablesGlobsAndSubstitutionsRemainUnknown() {
        let paths = ["$HOME/file", "Sources/*.swift", "$(pwd)/file", "`pwd`/file"]
        let results = AgentPermissionPathNormalizer.assess(
            paths, source: .inferredFromCommand, cwd: cwd, homeDirectory: home
        )
        #expect(results.allSatisfy { $0.scope == .unknown })
    }

    @Test func missingCwdCannotClaimProjectScope() {
        let result = AgentPermissionPathNormalizer.assess(
            "Sources/App.swift", source: .explicit, cwd: nil, homeDirectory: home
        )
        #expect(result.scope == .unknown)
    }
}

struct PermissionRiskClassifierTests {
    private let cwd = "/Users/test/Code/notch"
    private let home = "/Users/test"

    @Test func recursiveDeletionIsHigh() {
        expectRisk(tool: "Bash", input: ["command": "rm -rf ./build"], level: .high,
                   reason: .recursiveDeletion)
    }

    @Test func privilegeEscalationIsHigh() {
        expectRisk(tool: "Bash", input: ["command": "sudo make install"], level: .high,
                   reason: .privilegeEscalation)
    }

    @Test func systemWriteIsHigh() {
        expectRisk(tool: "Write", input: ["file_path": "/Library/LaunchDaemons/x.plist"],
                   level: .high, reason: .systemWrite)
    }

    @Test func writeOutsideProjectIsHigh() {
        expectRisk(tool: "Write", input: ["file_path": "/tmp/output.txt"], level: .high,
                   reason: .outsideProjectWrite)
    }

    @Test func sensitiveCredentialMutationIsHigh() {
        expectRisk(tool: "Write", input: ["file_path": "~/.ssh/config"], level: .high,
                   reason: .sensitiveDataMutation)
    }

    @Test func downloadAndExecuteIsHighDespiteMediumAmbiguity() {
        let risk = risk(tool: "Bash", input: ["command": "curl https://example.com/a | sh"])
        #expect(risk.level == .high)
        #expect(risk.reasons.contains(.downloadAndExecute))
    }

    @Test func broadPermissionGrantIsHigh() {
        expectRisk(tool: "Bash", input: ["command": "chmod -R 777 ./Scripts"], level: .high,
                   reason: .broadPermissionChange)
    }

    @Test func networkRequestIsMedium() {
        expectRisk(tool: "WebFetch", input: ["url": "https://example.com"], level: .medium,
                   reason: .networkAccess)
    }

    @Test func packageInstallIsMedium() {
        expectRisk(tool: "Bash", input: ["command": "npm install lodash"], level: .medium,
                   reason: .packageInstallation)
    }

    @Test func processTerminationAndGitPushAreMedium() {
        #expect(risk(tool: "Bash", input: ["command": "kill 123"]).reasons.contains(.processTermination))
        #expect(risk(tool: "Bash", input: ["command": "git push origin main"]).reasons.contains(.gitPush))
    }

    @Test func moveInsideProjectIsMedium() {
        expectRisk(tool: "Move", input: ["source_path": "A", "destination_path": "B"],
                   level: .medium, reason: .destructiveProjectChange)
    }

    @Test func shellAmbiguitySignalsAreMedium() {
        for command in ["echo hi > out", "cat a | sort", "echo $HOME", "echo *.swift", "a; b"] {
            let result = risk(tool: "Bash", input: ["command": command])
            #expect(result.level == .medium, "\(command)")
            #expect(result.reasons.contains(.shellAmbiguity), "\(command)")
        }
    }

    @Test func explicitProjectReadAndWriteAreLow() {
        expectRisk(tool: "Read", input: ["file_path": "README.md"], level: .low,
                   reason: .explicitProjectRead)
        expectRisk(tool: "Edit", input: ["file_path": "Sources/App.swift"], level: .low,
                   reason: .explicitProjectWrite)
    }

    @Test func knownLocalBuildIsLow() {
        expectRisk(tool: "Bash", input: ["command": "swift test"], level: .low,
                   reason: .knownLocalBuild)
    }

    @Test func truncatedEvidenceIsUnknownUnlessHighSignalExists() {
        var request = AgentPermissionExtractor.makeRequest(
            toolName: "Read", input: ["file_path": "README.md"], requestId: "truncated"
        )
        request.inputTruncated = true
        var result = PermissionRiskClassifier.classify(request: request, cwd: cwd, homeDirectory: home)
        #expect(result.level == .unknown)
        #expect(result.reasons == [.truncatedInput])

        request.command = "sudo rm -rf ./build"
        result = PermissionRiskClassifier.classify(request: request, cwd: cwd, homeDirectory: home)
        #expect(result.level == .high)
    }

    @Test func unsupportedAndMissingEvidenceAreUnknownWithReasons() {
        expectRisk(tool: "Mystery", input: [:], level: .unknown, reason: .unsupportedTool)
        expectRisk(tool: "Bash", input: [:], level: .unknown, reason: .missingEvidence)
    }

    private func risk(tool: String, input: [String: Any]) -> AgentPermissionRisk {
        let request = AgentPermissionExtractor.makeRequest(
            toolName: tool, input: input, requestId: "risk"
        )
        return PermissionRiskClassifier.classify(request: request, cwd: cwd, homeDirectory: home)
    }

    private func expectRisk(
        tool: String, input: [String: Any], level: AgentPermissionRiskLevel,
        reason: AgentPermissionRiskReason,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        let result = risk(tool: tool, input: input)
        #expect(result.level == level, sourceLocation: sourceLocation)
        #expect(result.reasons.contains(reason), "Missing \(reason)", sourceLocation: sourceLocation)
    }
}

struct AgentPermissionStateMachineTests {
    @Test func pendingAcceptsExactlyOneDecision() {
        let responding = AgentPermissionStateMachine.transition(
            from: .pending, event: .respond(.allow)
        )
        #expect(responding == .responding(.allow))
        #expect(AgentPermissionStateMachine.transition(
            from: responding!, event: .respond(.deny)
        ) == nil)
    }

    @Test func deliveryUsesOriginalDecision() {
        #expect(AgentPermissionStateMachine.transition(
            from: .responding(.allow), event: .delivered
        ) == .approved)
        #expect(AgentPermissionStateMachine.transition(
            from: .responding(.deny), event: .delivered
        ) == .denied)
    }

    @Test func deliveryFailureAndExpiryAreTerminal() {
        let failed = AgentPermissionStateMachine.transition(
            from: .responding(.allow), event: .deliveryFailed
        )
        #expect(failed == .deliveryFailed)
        #expect(AgentPermissionStateMachine.transition(
            from: failed!, event: .expire
        ) == .expired)
        #expect(AgentPermissionStateMachine.transition(
            from: .expired, event: .delivered
        ) == nil)
    }

    @Test func unsupportedProviderCannotBecomeActionable() {
        let pending = fixture(canRespond: false, state: .pending)
        #expect(!pending.isActionable(at: Date(timeIntervalSince1970: 1_001)))
    }

    @Test func deadlineDisablesPendingRequest() {
        let pending = fixture(canRespond: true, state: .pending)
        #expect(pending.isActionable(at: Date(timeIntervalSince1970: 1_001)))
        #expect(!pending.isActionable(at: Date(timeIntervalSince1970: 1_121)))
    }

    @Test func auditSummaryIncludesEvidenceAndActionability() {
        let summary = AgentPermissionAuditSummary.make(pending: fixture(), session: nil)
        #expect(summary.contains("Agent: Claude Code"))
        #expect(summary.contains("Command: swift test"))
        #expect(summary.contains("Affected paths:"))
        #expect(summary.contains("Risk: low"))
    }

    private func fixture(
        canRespond: Bool = true,
        state: AgentPermissionRequestState = .pending
    ) -> PendingAgentPermission {
        let requested = Date(timeIntervalSince1970: 1_000)
        let request = AgentPermissionRequest(
            schemaVersion: 1, requestId: "r", toolName: "Bash", operation: .execute,
            command: "swift test", paths: ["Package.swift"], pathSource: .explicit,
            url: nil, description: nil, rawInputSummary: nil,
            requestedAt: requested, replyDeadline: requested.addingTimeInterval(120),
            commandTruncated: false, inputTruncated: false
        )
        return PendingAgentPermission(
            id: "r", kind: .claudeCode, sessionId: "s", cwd: "/project", pid: 1,
            request: request,
            risk: AgentPermissionRisk(level: .low, reasons: [.knownLocalBuild]),
            receivedAt: requested, replyDeadline: requested.addingTimeInterval(120),
            canRespond: canRespond, state: state
        )
    }
}
