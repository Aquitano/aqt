import Foundation
@testable import NotchCore
import Testing

/// `TranscriptParser` parses bytes, not a path, so these fixtures are plain
/// JSONL strings — no transcript files on disk. The source is compiled into this
/// logic-test target (see `project.yml`).
struct TranscriptParserTests {
    /// Build a transcript blob from individual JSONL lines (oldest first, as on
    /// disk). The parser reads it back-to-front.
    private func transcript(_ lines: String...) -> Data {
        Data(lines.joined(separator: "\n").utf8)
    }

    @Test func emptyInputIsIdleDefault() {
        // Nothing to read is the absence of evidence, not evidence of a turn: the
        // old `.running` default published every unreadable tail as a busy session.
        let state = TranscriptParser.parse(Data())
        #expect(state == TranscriptState(branch: nil, busy: .idle, verb: nil, prompt: nil, response: nil))
    }

    @Test func garbageLinesAreSkipped() {
        let state = TranscriptParser.parse(transcript("not json", "{", "42"))
        #expect(state.busy == .idle)
        #expect(state.prompt == nil)
    }

    @Test func clearedSessionIsNotRunning() {
        // `/clear` writes its own echo into the brand-new transcript as user
        // entries. Read as a prompt, they made every fresh chat a busy session
        // whose preview was "<command-name>/clear</command-name>".
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: the messages below</local-command-caveat>"}}"#,
            #"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>"}}"#
        ))
        #expect(state.busy == .idle)
        #expect(state.prompt == nil)
    }

    @Test func commandEchoDoesNotHideTheRealTurn() {
        // Skipping the echo must keep looking, not stop the scan.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"ship it"}}"#,
            #"{"type":"user","message":{"content":"<command-name>/cost</command-name>"}}"#
        ))
        #expect(state.busy == .running)
        #expect(state.prompt == "ship it")
    }

    @Test func lastActivityComesFromTheNewestEntry() {
        // Transcripts get touched by backup and sync tools, so the file mtime is
        // not when the session last did anything — the newest entry is.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"go"},"timestamp":"2026-09-01T10:00:00.000Z"}"#,
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]},"timestamp":"2026-09-01T10:00:09.500Z"}"#
        ))
        #expect(state.lastEntryAt == Date(timeIntervalSince1970: 1_788_256_809.5))
    }

    @Test func terminalAssistantIsIdle() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"refactor the parser"},"gitBranch":"agent-watch"}"#,
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"All done."}]}}"#
        ))
        #expect(state.busy == .idle)
        #expect(state.verb == nil)
        #expect(state.response == "All done.")
        #expect(state.prompt == "refactor the parser")
        #expect(state.branch == "agent-watch")
    }

    @Test func pendingEditToolIsEditing() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"editing"},{"type":"tool_use","name":"Edit"}]}}"#
        ))
        #expect(state.busy == .editing)
        #expect(state.verb == "Editing")
    }

    @Test func pendingBashToolIsTool() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash"}]}}"#
        ))
        #expect(state.busy == .tool)
        #expect(state.verb == "Running")
    }

    @Test func textPreambleWithToolStopReasonIsRunning() {
        // A thinking/text preamble whose turn continues with a tool in the *next*
        // message: no tool_use block here yet, but stop_reason says more is coming.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Let me look"}]}}"#
        ))
        #expect(state.busy == .running)
        #expect(state.verb == "Thinking")
    }

    @Test func trailingUserEntryIsRunning() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}"#,
            #"{"type":"user","message":{"content":"and now the tests"}}"#
        ))
        #expect(state.busy == .running)
        #expect(state.verb == "Thinking")
        #expect(state.prompt == "and now the tests")
    }

    @Test func toolResultUserEntryIsSkippedForRealPrompt() {
        // A trailing user entry carrying tool_result is tool output, not a prompt:
        // it reads as busy (the turn continues) but the prompt is taken from the
        // genuine earlier user message, not the tool_result.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"do it"}}"#,
            #"{"type":"user","message":{"content":[{"type":"tool_result","content":"exit 0"}]}}"#
        ))
        #expect(state.busy == .running)
        #expect(state.prompt == "do it")
    }

    @Test func toolResultOnlyHasNoPrompt() {
        // A tool_result entry on its own never produces a prompt.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":[{"type":"tool_result","content":"exit 0"}]}}"#
        ))
        #expect(state.busy == .running)
        #expect(state.prompt == nil)
    }

    @Test func interruptEntryIsIdle() {
        // Esc writes a synthetic "[Request interrupted by user]" user entry and no
        // Stop hook fires; it must read as idle, not a busy prompt.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":"long task"}}"#,
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash"}]}}"#,
            #"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#
        ))
        #expect(state.busy == .idle)
        #expect(state.verb == nil)
        #expect(state.prompt == "long task")
    }

    @Test func interruptMarkerIsNotAPrompt() {
        let state = TranscriptParser.parse(transcript(
            #"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#
        ))
        #expect(state.busy == .idle)
        #expect(state.prompt == nil)
    }

    @Test func statusComesFromNewestAssistantOnly() {
        // The reverse scan locks status on the newest (last) assistant: a terminal
        // end_turn after an earlier tool_use is idle, not editing.
        let state = TranscriptParser.parse(transcript(
            #"{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Edit"}]}}"#,
            #"{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"finished"}]}}"#
        ))
        #expect(state.busy == .idle)
        #expect(state.response == "finished")
    }
}
