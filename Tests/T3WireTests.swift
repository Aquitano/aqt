import XCTest

/// `T3Wire` is the pure byte-level layer of the t3 integration, so the frame
/// decode, the thread -> session mapping, and the event diff are table-tested
/// here against hand-written wire fixtures (shapes taken from t3's contracts).
final class T3WireTests: XCTestCase {

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

    func testDecodesSnapshotChunkAndNumericRequestId() {
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
            return XCTFail("expected chunk, got \(messages)")
        }
        XCTAssertEqual(requestId, .number(4))
        XCTAssertFalse(drift)
        guard case let .snapshot(projects, threads) = items.first else {
            return XCTFail("expected snapshot, got \(items)")
        }
        XCTAssertEqual(projects.first?.title, "Demo")
        XCTAssertEqual(threads.first?.sessionStatus, "running")
        XCTAssertEqual(threads.first?.providerName, "claude-code")
    }

    func testUnknownTagsAndItemKindsAreSkippedNotFatal() {
        let data = chunkData(items: [
            ["kind": "brand-new-kind", "whatever": 1],
            ["kind": "thread-removed", "threadId": "t9"],
        ])
        let frames = T3Wire.decodeFrames(Data("{\"_tag\":\"SomethingNew\"}".utf8))
        XCTAssertTrue(frames.isEmpty)
        guard case let .chunk(_, items, drift) = T3Wire.decodeFrames(data).first else {
            return XCTFail("expected chunk")
        }
        XCTAssertEqual(items, [.threadRemoved("t9")])
        // A new benign kind next to a decodable item is not drift.
        XCTAssertFalse(drift)
    }

    func testDriftFlagsWhenNothingInAChunkDecodes() {
        let data = chunkData(items: [["kind": "thread-upserted", "thread": ["renamed": true]]])
        guard case let .chunk(_, items, drift) = T3Wire.decodeFrames(data).first else {
            return XCTFail("expected chunk")
        }
        XCTAssertTrue(items.isEmpty)
        XCTAssertTrue(drift)
    }

    func testDriftFlagsWhenSnapshotThreadsNoLongerDecode() {
        let data = chunkData(items: [[
            "kind": "snapshot",
            "snapshot": [
                "projects": [[String: Any]](),
                "threads": [["threadIdentifier": "renamed-field"]],
            ],
        ]])
        guard case let .chunk(_, items, drift) = T3Wire.decodeFrames(data).first else {
            return XCTFail("expected chunk")
        }
        XCTAssertEqual(items, [.snapshot(projects: [], threads: [])])
        XCTAssertTrue(drift)
    }

    func testEmptySnapshotIsNotDrift() {
        let data = chunkData(items: [[
            "kind": "snapshot",
            "snapshot": ["projects": [[String: Any]](), "threads": [[String: Any]]()],
        ]])
        guard case let .chunk(_, _, drift) = T3Wire.decodeFrames(data).first else {
            return XCTFail("expected chunk")
        }
        XCTAssertFalse(drift)
    }

    func testVersionComparison() {
        XCTAssertTrue(T3Wire.isVersion("0.0.40", newerThan: "0.0.35"))
        XCTAssertTrue(T3Wire.isVersion("0.1.0", newerThan: "0.0.35"))
        XCTAssertTrue(T3Wire.isVersion("1.0", newerThan: "0.9.9"))
        XCTAssertFalse(T3Wire.isVersion("0.0.35", newerThan: "0.0.35"))
        XCTAssertFalse(T3Wire.isVersion("0.0.30", newerThan: "0.0.35"))
        XCTAssertFalse(T3Wire.isVersion("0.0", newerThan: "0.0.35"))
    }

    func testAckEchoesRequestIdType() throws {
        let ack = try XCTUnwrap(
            JSONSerialization.jsonObject(with: T3Wire.ack(.number(4))) as? [String: Any]
        )
        XCTAssertEqual(ack["_tag"] as? String, "Ack")
        XCTAssertEqual(ack["requestId"] as? Int, 4)
    }

    // MARK: - Status mapping

    func testStatusMapping() {
        func status(_ dict: [String: Any]) -> AgentStatus? {
            T3Wire.status(of: T3Thread(dict)!)
        }
        XCTAssertEqual(status(thread(id: "a", status: "running")), .running)
        XCTAssertEqual(status(thread(id: "b", status: "starting")), .running)
        XCTAssertEqual(status(thread(id: "c", status: "ready")), .finished)
        XCTAssertEqual(status(thread(id: "d", status: "running", approvals: true)), .needsAttention)
        XCTAssertEqual(status(thread(id: "e", status: "ready", userInput: true)), .needsAttention)
        // Dormant or dead threads are hidden entirely.
        XCTAssertNil(status(thread(id: "f", status: "idle")))
        XCTAssertNil(status(thread(id: "g", status: "stopped")))
        XCTAssertNil(status(thread(id: "h", status: nil)))
        XCTAssertNil(status(thread(id: "i", status: "running", archived: true)))
    }

    func testSessionMappingCarriesProjectBranchAndProviderBadge() {
        var state = T3ShellState()
        state.apply(.snapshot(
            projects: [T3Project(["id": "p1", "title": "Demo", "workspaceRoot": "/tmp/demo"])!],
            threads: [T3Thread(thread(id: "t1"))!]
        ))
        let sessions = state.sessions(previous: [:], now: Date())
        let session = sessions["t3-t1"]
        XCTAssertEqual(session?.kind, .t3code)
        XCTAssertEqual(session?.project, "Demo")
        XCTAssertEqual(session?.gitBranch, "main")
        XCTAssertEqual(session?.terminalName, "claude-code")
        XCTAssertEqual(session?.lastPrompt, "Fix the tests")
    }

    func testStartedAtSurvivesUpdates() {
        var state = T3ShellState()
        state.apply(.threadUpserted(T3Thread(thread(id: "t1"))!))
        let early = Date(timeIntervalSinceNow: -100)
        let first = state.sessions(previous: [:], now: early)
        state.apply(.threadUpserted(T3Thread(thread(id: "t1", status: "ready"))!))
        let second = state.sessions(previous: first, now: Date())
        XCTAssertEqual(second["t3-t1"]?.startedAt, early)
        XCTAssertEqual(second["t3-t1"]?.status, .finished)
    }

    // MARK: - Event diff

    func testEventDiffEmitsStartedFinishedAttentionAndEnded() {
        var state = T3ShellState()
        state.apply(.snapshot(projects: [], threads: [
            T3Thread(thread(id: "run"))!,
            T3Thread(thread(id: "gone"))!,
        ]))
        let before = state.sessions(previous: [:], now: Date())

        state.apply(.threadUpserted(T3Thread(thread(id: "run", status: "ready"))!))
        state.apply(.threadUpserted(T3Thread(thread(id: "ask", approvals: true))!))
        state.apply(.threadRemoved("gone"))
        let after = state.sessions(previous: before, now: Date())

        let events = T3Wire.events(previous: before, current: after)
        let kinds = Dictionary(grouping: events, by: { $0.session.id }).mapValues { $0.map(\.kind) }
        XCTAssertEqual(kinds["t3-run"], [.finished])
        XCTAssertEqual(kinds["t3-ask"], [.started])
        XCTAssertEqual(kinds["t3-gone"], [.ended])
    }

    func testNoEventsWhenNothingChanged() {
        var state = T3ShellState()
        state.apply(.threadUpserted(T3Thread(thread(id: "t1"))!))
        let sessions = state.sessions(previous: [:], now: Date())
        XCTAssertTrue(T3Wire.events(previous: sessions, current: sessions).isEmpty)
    }

    // MARK: - Pairing links

    func testPairingLinkParsesUrlWithFragmentToken() throws {
        let parsed = try XCTUnwrap(T3Wire.pairingLink("http://127.0.0.1:3773/pair#token=abc123"))
        XCTAssertEqual(parsed.credential, "abc123")
        XCTAssertEqual(parsed.baseURL?.absoluteString, "http://127.0.0.1:3773")
    }

    func testPairingLinkAcceptsBareCredential() throws {
        let parsed = try XCTUnwrap(T3Wire.pairingLink("  abc123  "))
        XCTAssertEqual(parsed.credential, "abc123")
        XCTAssertNil(parsed.baseURL)
        XCTAssertNil(T3Wire.pairingLink("http://127.0.0.1:3773/pair"))
        XCTAssertNil(T3Wire.pairingLink("   "))
    }

    func testTokenExchangeBodyRequestsReadOnlyScope() {
        let body = String(data: T3Wire.tokenExchangeBody(credential: "abc"), encoding: .utf8)!
        XCTAssertTrue(body.contains("scope=orchestration:read"))
        XCTAssertTrue(body.contains("subject_token=abc"))
        XCTAssertFalse(body.contains("operate"))
    }
}
