import Foundation
import Testing
@testable import NotchCore

/// `T3Wire` is the pure byte-level layer of the t3 integration, so the frame
/// decode, the thread -> session mapping, and the event diff are table-tested
/// here against hand-written wire fixtures (shapes taken from t3's contracts).
struct T3WireTests {

    // MARK: - Frame decoding

    private func chunkData(items: [[String: Any]], requestId: Any = "1") -> Data {
        try! JSONSerialization.data(withJSONObject: [
            "_tag": "Chunk", "requestId": requestId, "values": items,
        ])
    }

    private func thread(
        id: String, title: String = "Fix the tests", status: String? = "running",
        approvals: Bool = false, userInput: Bool = false, archived: Bool = false,
        provider: String? = "claude-code"
    ) -> [String: Any] {
        var dict: [String: Any] = [
            "id": id, "projectId": "p1", "title": title,
            "branch": "main", "worktreePath": "/tmp/demo",
            "hasPendingApprovals": approvals, "hasPendingUserInput": userInput,
            "updatedAt": "2026-08-27T10:00:00.000Z",
        ]
        if archived { dict["archivedAt"] = "2026-08-27T09:00:00.000Z" }
        if let status {
            var session: [String: Any] = ["status": status]
            if let provider { session["providerName"] = provider }
            dict["session"] = session
        }
        return dict
    }

    @Test func decodesSnapshotChunkAndNumericRequestId() {
        let data = chunkData(items: [[
            "kind": "snapshot",
            "snapshot": [
                "snapshotSequence": 7,
                "projects": [["id": "p1", "title": "Demo", "workspaceRoot": "/tmp/demo"]],
                "threads": [thread(id: "t1")],
                "updatedAt": "2026-08-27T10:00:00.000Z",
            ],
        ]], requestId: 4)

        let messages = T3Wire.decodeFrames(data)
        guard case let .chunk(requestId, items, drift) = messages.first else {
            Issue.record("expected chunk, got \(messages)")
            return
        }
        #expect(requestId == .number(4))
        #expect(!drift)
        guard case let .snapshot(projects, threads) = items.first else {
            Issue.record("expected snapshot, got \(items)")
            return
        }
        #expect(projects.first?.title == "Demo")
        #expect(threads.first?.sessionStatus == "running")
        #expect(threads.first?.providerName == "claude-code")
    }

    @Test func unknownTagsAndItemKindsAreSkippedNotFatal() {
        let data = chunkData(items: [
            ["kind": "brand-new-kind", "whatever": 1],
            ["kind": "thread-removed", "threadId": "t9"],
        ])
        let frames = T3Wire.decodeFrames(Data("{\"_tag\":\"SomethingNew\"}".utf8))
        #expect(frames.isEmpty)
        guard case let .chunk(_, items, drift) = T3Wire.decodeFrames(data).first else {
            Issue.record("expected chunk")
            return
        }
        #expect(items == [.threadRemoved("t9")])
        // A new benign kind next to a decodable item is not drift.
        #expect(!drift)
    }

    @Test func driftFlagsWhenNothingInAChunkDecodes() {
        let data = chunkData(items: [["kind": "thread-upserted", "thread": ["renamed": true]]])
        guard case let .chunk(_, items, drift) = T3Wire.decodeFrames(data).first else {
            Issue.record("expected chunk")
            return
        }
        #expect(items.isEmpty)
        #expect(drift)
    }

    @Test func driftFlagsWhenSnapshotThreadsNoLongerDecode() {
        let data = chunkData(items: [[
            "kind": "snapshot",
            "snapshot": [
                "projects": [[String: Any]](),
                "threads": [["threadIdentifier": "renamed-field"]],
            ],
        ]])
        guard case let .chunk(_, items, drift) = T3Wire.decodeFrames(data).first else {
            Issue.record("expected chunk")
            return
        }
        #expect(items == [.snapshot(projects: [], threads: [])])
        #expect(drift)
    }

    @Test func emptySnapshotIsNotDrift() {
        let data = chunkData(items: [[
            "kind": "snapshot",
            "snapshot": ["projects": [[String: Any]](), "threads": [[String: Any]]()],
        ]])
        guard case let .chunk(_, _, drift) = T3Wire.decodeFrames(data).first else {
            Issue.record("expected chunk")
            return
        }
        #expect(!drift)
    }

    @Test func shellSnapshotResponseDecodesBareSnapshotShape() throws {
        // GET /api/orchestration/shell returns the snapshot struct directly.
        let data = try JSONSerialization.data(withJSONObject: [
            "snapshotSequence": 12,
            "projects": [["id": "p1", "title": "Demo", "workspaceRoot": "/tmp/demo"]],
            "threads": [thread(id: "t1")],
            "updatedAt": "2026-08-27T10:00:00.000Z",
        ])
        let decoded = T3Wire.shellSnapshotResponse(data)
        #expect(!decoded.drift)
        guard case let .snapshot(projects, threads) = decoded.item else {
            Issue.record("expected snapshot, got \(String(describing: decoded.item))")
            return
        }
        #expect(projects.first?.title == "Demo")
        #expect(threads.first?.id == "t1")
    }

    @Test func shellSnapshotResponseFlagsDriftOnForeignOrUndecodableShape() throws {
        let foreign = T3Wire.shellSnapshotResponse(Data("{\"error\":\"nope\"}".utf8))
        #expect(foreign.item == nil)
        #expect(foreign.drift)

        let undecodableThreads = try JSONSerialization.data(withJSONObject: [
            "projects": [[String: Any]](),
            "threads": [["threadIdentifier": "renamed"]],
        ])
        let decoded = T3Wire.shellSnapshotResponse(undecodableThreads)
        #expect(decoded.item == .snapshot(projects: [], threads: []))
        #expect(decoded.drift)
    }

    @Test func versionComparison() {
        #expect(T3Wire.isVersion("0.0.40", newerThan: "0.0.35"))
        #expect(T3Wire.isVersion("0.1.0", newerThan: "0.0.35"))
        #expect(T3Wire.isVersion("1.0", newerThan: "0.9.9"))
        #expect(!T3Wire.isVersion("0.0.35", newerThan: "0.0.35"))
        #expect(!T3Wire.isVersion("0.0.30", newerThan: "0.0.35"))
        #expect(!T3Wire.isVersion("0.0", newerThan: "0.0.35"))
    }

    @Test func ackEchoesRequestIdType() throws {
        let ack = try #require(
            JSONSerialization.jsonObject(with: T3Wire.ack(.number(4))) as? [String: Any]
        )
        #expect(ack["_tag"] as? String == "Ack")
        #expect(ack["requestId"] as? Int == 4)
    }

    // MARK: - Status mapping

    @Test func statusMapping() {
        func status(_ dict: [String: Any]) -> AgentStatus? {
            T3Wire.status(of: T3Thread(dict)!)
        }
        #expect(status(thread(id: "a", status: "running")) == .running)
        #expect(status(thread(id: "b", status: "starting")) == .running)
        #expect(status(thread(id: "c", status: "ready")) == .finished)
        #expect(status(thread(id: "d", status: "running", approvals: true)) == .needsAttention)
        #expect(status(thread(id: "e", status: "ready", userInput: true)) == .needsAttention)
        // Dormant or dead threads are hidden entirely.
        #expect(status(thread(id: "f", status: "idle")) == nil)
        #expect(status(thread(id: "g", status: "stopped")) == nil)
        #expect(status(thread(id: "h", status: nil)) == nil)
        #expect(status(thread(id: "i", status: "running", archived: true)) == nil)
    }

    private let environment = T3Environment(id: "env1", label: "ubuntu", baseURL: "https://ubuntu.example")

    @Test func sessionMappingCarriesProjectBranchAndHostBadge() {
        var state = T3ShellState()
        state.apply(.snapshot(
            projects: [T3Project(["id": "p1", "title": "Demo", "workspaceRoot": "/tmp/demo"])!],
            threads: [T3Thread(thread(id: "t1"))!]
        ))
        let sessions = state.sessions(environment: environment, previous: [:], now: Date())
        let session = sessions["t3-env1-t1"]
        #expect(session?.kind == .t3code)
        #expect(session?.project == "Demo")
        #expect(session?.gitBranch == "main")
        // The badge names the machine; the underlying agent rides in detail.
        #expect(session?.terminalName == "ubuntu")
        #expect(session?.detail == "claude-code")
        #expect(session?.lastPrompt == "Fix the tests")
        #expect(session?.t3Thread == T3ThreadRef(environmentID: "env1", threadID: "t1"))
    }

    @Test func threadRefReadsTheTerminalEnvironmentAndBuildsADeepLink() {
        let ref = T3ThreadRef(processEnvironment: [
            T3ThreadRef.environmentIDKey: "env 1", T3ThreadRef.threadIDKey: "t/1",
        ])
        #expect(ref?.deepLink?.absoluteString == "t3code://threads/env%201/t%2F1")
        #expect(T3ThreadRef(processEnvironment: [T3ThreadRef.environmentIDKey: "env1"]) == nil)
    }

    @Test func startedAtSurvivesUpdates() {
        var state = T3ShellState()
        state.apply(.threadUpserted(T3Thread(thread(id: "t1"))!))
        let early = Date(timeIntervalSinceNow: -100)
        let first = state.sessions(environment: environment, previous: [:], now: early)
        state.apply(.threadUpserted(T3Thread(thread(id: "t1", status: "ready"))!))
        let second = state.sessions(environment: environment, previous: first, now: Date())
        #expect(second["t3-env1-t1"]?.startedAt == early)
        #expect(second["t3-env1-t1"]?.status == .finished)
    }

    // MARK: - Event diff

    @Test func eventDiffEmitsStartedFinishedAttentionAndEnded() {
        var state = T3ShellState()
        state.apply(.snapshot(projects: [], threads: [
            T3Thread(thread(id: "run"))!,
            T3Thread(thread(id: "gone"))!,
        ]))
        let before = state.sessions(environment: environment, previous: [:], now: Date())

        state.apply(.threadUpserted(T3Thread(thread(id: "run", status: "ready"))!))
        state.apply(.threadUpserted(T3Thread(thread(id: "ask", approvals: true))!))
        state.apply(.threadRemoved("gone"))
        let after = state.sessions(environment: environment, previous: before, now: Date())

        let events = T3Wire.events(previous: before, current: after)
        let kinds = Dictionary(grouping: events, by: { $0.session.id }).mapValues { $0.map(\.kind) }
        #expect(kinds["t3-env1-run"] == [.finished])
        #expect(kinds["t3-env1-ask"] == [.started])
        #expect(kinds["t3-env1-gone"] == [.ended])
    }

    @Test func noEventsWhenNothingChanged() {
        var state = T3ShellState()
        state.apply(.threadUpserted(T3Thread(thread(id: "t1"))!))
        let sessions = state.sessions(environment: environment, previous: [:], now: Date())
        #expect(T3Wire.events(previous: sessions, current: sessions).isEmpty)
    }

    // MARK: - Pairing links

    @Test func pairingLinkParsesUrlWithFragmentToken() throws {
        let parsed = try #require(T3Wire.pairingLink("http://127.0.0.1:3773/pair#token=abc123"))
        #expect(parsed.credential == "abc123")
        #expect(parsed.baseURL?.absoluteString == "http://127.0.0.1:3773")
    }

    @Test func pairingLinkAcceptsBareCredential() throws {
        let parsed = try #require(T3Wire.pairingLink("  abc123  "))
        #expect(parsed.credential == "abc123")
        #expect(parsed.baseURL == nil)
        #expect(T3Wire.pairingLink("http://127.0.0.1:3773/pair") == nil)
        #expect(T3Wire.pairingLink("   ") == nil)
    }

    @Test func tokenExchangeBodyRequestsReadOnlyScope() {
        let body = String(data: T3Wire.tokenExchangeBody(credential: "abc"), encoding: .utf8)!
        #expect(body.contains("scope=orchestration:read"))
        #expect(body.contains("subject_token=abc"))
        #expect(!body.contains("operate"))
    }
}
