import XCTest

/// `TranscriptParser` parses bytes, not a path, so these fixtures are plain
/// JSONL strings — no transcript files on disk. The source is compiled into this
/// logic-test target (see `project.yml`).
final class TranscriptParserTests: XCTestCase {

    /// Build a transcript blob from individual JSONL lines (oldest first, as on
    /// disk). The parser reads it back-to-front.
    private func transcript(_ lines: String...) -> Data {
        Data(lines.joined(separator: "\n").utf8)
    }

    func testEmptyInputIsRunningDefault() {
        let state = TranscriptParser.parse(Data())
        XCTAssertEqual(state, TranscriptState(branch: nil, busy: .running, verb: nil, prompt: nil, response: nil))
    }

    func testGarbageLinesAreSkipped() {
        let state = TranscriptParser.parse(transcript("not json", "{", "42"))
        XCTAssertEqual(state.busy, .running)
        XCTAssertNil(state.prompt)
    }

    func testTerminalAssistantIsIdle() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"refactor the parser"},"gitBranch":"agent-watch"}"#,
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"All done."}]}}"#
        ))
        XCTAssertEqual(state.busy, .idle)
        XCTAssertNil(state.verb)
        XCTAssertEqual(state.response, "All done.")
        XCTAssertEqual(state.prompt, "refactor the parser")
        XCTAssertEqual(state.branch, "agent-watch")
    }

    func testPendingEditToolIsEditing() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"editing"},{"type":"tool_use","name":"Edit"}]}}"#
        ))
        XCTAssertEqual(state.busy, .editing)
        XCTAssertEqual(state.verb, "Editing")
    }

    func testPendingBashToolIsTool() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash"}]}}"#
        ))
        XCTAssertEqual(state.busy, .tool)
        XCTAssertEqual(state.verb, "Running")
    }

    func testTextPreambleWithToolStopReasonIsRunning() {
        // A thinking/text preamble whose turn continues with a tool in the *next*
        // message: no tool_use block here yet, but stop_reason says more is coming.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Let me look"}]}}"#
        ))
        XCTAssertEqual(state.busy, .running)
        XCTAssertEqual(state.verb, "Thinking")
    }

    func testTrailingUserEntryIsRunning() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}"#,
            #"{"type":"user","message":{"content":"and now the tests"}}"#
        ))
        XCTAssertEqual(state.busy, .running)
        XCTAssertEqual(state.verb, "Thinking")
        XCTAssertEqual(state.prompt, "and now the tests")
    }

    func testToolResultUserEntryIsSkippedForRealPrompt() {
        // A trailing user entry carrying tool_result is tool output, not a prompt:
        // it reads as busy (the turn continues) but the prompt is taken from the
        // genuine earlier user message, not the tool_result.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"do it"}}"#,
            #"{"type":"user","message":{"content":[{"type":"tool_result","content":"exit 0"}]}}"#
        ))
        XCTAssertEqual(state.busy, .running)
        XCTAssertEqual(state.prompt, "do it")
    }

    func testToolResultOnlyHasNoPrompt() {
        // A tool_result entry on its own never produces a prompt.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":[{"type":"tool_result","content":"exit 0"}]}}"#
        ))
        XCTAssertEqual(state.busy, .running)
        XCTAssertNil(state.prompt)
    }

    func testInterruptEntryIsIdle() {
        // Esc writes a synthetic "[Request interrupted by user]" user entry and no
        // Stop hook fires; it must read as idle, not a busy prompt.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"long task"}}"#,
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash"}]}}"#,
            #"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#
        ))
        XCTAssertEqual(state.busy, .idle)
        XCTAssertNil(state.verb)
        XCTAssertEqual(state.prompt, "long task")
    }

    func testInterruptMarkerIsNotAPrompt() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#
        ))
        XCTAssertEqual(state.busy, .idle)
        XCTAssertNil(state.prompt)
    }

    func testStatusComesFromNewestAssistantOnly() {
        // The reverse scan locks status on the newest (last) assistant: a terminal
        // end_turn after an earlier tool_use is idle, not editing.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Edit"}]}}"#,
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"finished"}]}}"#
        ))
        XCTAssertEqual(state.busy, .idle)
        XCTAssertEqual(state.response, "finished")
    }
}
