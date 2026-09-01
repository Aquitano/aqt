import XCTest
@testable import NotchCore

/// `TranscriptParser` parses bytes, not a path, so these fixtures are plain
/// JSONL strings — no transcript files on disk. The source is compiled into this
/// logic-test target (see `project.yml`).
final class TranscriptParserTests: XCTestCase {

    /// Build a transcript blob from individual JSONL lines (oldest first, as on
    /// disk). The parser reads it back-to-front.
    private func transcript(_ lines: String...) -> Data {
        Data(lines.joined(separator: "\n").utf8)
    }

    func testEmptyInputIsIdleDefault() {
        // Nothing to read is the absence of evidence, not evidence of a turn: the
        // old `.running` default published every unreadable tail as a busy session.
        let state = TranscriptParser.parse(Data())
        XCTAssertEqual(state, TranscriptState(branch: nil, busy: .idle, verb: nil, prompt: nil, response: nil))
    }

    func testGarbageLinesAreSkipped() {
        let state = TranscriptParser.parse(transcript("not json", "{", "42"))
        XCTAssertEqual(state.busy, .idle)
        XCTAssertNil(state.prompt)
    }

    func testClearedSessionIsNotRunning() {
        // `/clear` writes its own echo into the brand-new transcript as user
        // entries. Read as a prompt, they made every fresh chat a busy session
        // whose preview was "<command-name>/clear</command-name>".
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: the messages below</local-command-caveat>"}}"#,
            #"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>"}}"#
        ))
        XCTAssertEqual(state.busy, .idle)
        XCTAssertNil(state.prompt)
    }

    func testCommandEchoDoesNotHideTheRealTurn() {
        // Skipping the echo must keep looking, not stop the scan.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"ship it"}}"#,
            #"{"type":"user","message":{"content":"<command-name>/cost</command-name>"}}"#
        ))
        XCTAssertEqual(state.busy, .running)
        XCTAssertEqual(state.prompt, "ship it")
    }

    func testLastActivityComesFromTheNewestEntry() {
        // Transcripts get touched by backup and sync tools, so the file mtime is
        // not when the session last did anything — the newest entry is.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"go"},"timestamp":"2026-09-01T10:00:00.000Z"}"#,
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]},"timestamp":"2026-09-01T10:00:09.500Z"}"#
        ))
        XCTAssertEqual(state.lastEntryAt, Date(timeIntervalSince1970: 1_788_256_809.5))
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
