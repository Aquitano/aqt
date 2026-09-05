import Foundation

/// What one reverse pass over a Claude transcript tail tells us: whether the
/// turn is still in progress (and doing what), the git branch, and the latest
/// prompt/response for the expanded preview.
package struct TranscriptState: Equatable, Sendable {
    package var branch: String?
    /// Busy-vs-idle inferred from the transcript structure (a pending `tool_use`
    /// or an unanswered prompt is busy; a text-only final turn is idle).
    package var busy: AgentStatus
    package var verb: String?
    package var prompt: String?
    package var response: String?
    /// Timestamp of the newest entry, which is when the session actually last did
    /// something. The file's mtime is not that: transcripts get touched by backup
    /// and sync tools, which would keep a long-dead session looking fresh.
    package var lastEntryAt: Date?
}

/// Parses Claude's `*.jsonl` transcripts into a `TranscriptState`. Operates on
/// the raw tail bytes, never a path — so it's exercisable with fixtures and has
/// no dependency on a live session on disk. The file I/O that produces those
/// bytes lives in `SessionProbe`.
package enum TranscriptParser {

    /// One reverse pass over the transcript tail collecting branch, busy status,
    /// the latest user prompt, and the latest assistant reply. Lines that aren't
    /// valid JSON objects are skipped.
    ///
    /// The default is `.idle`: a tail with nothing to say about the turn is the
    /// absence of evidence, not evidence of work. Defaulting to `.running` made
    /// every freshly cleared chat — and anything the tail window couldn't reach —
    /// show up as a busy session that never stopped.
    package static func parse(_ data: Data) -> TranscriptState {
        var branch: String?
        var status: AgentStatus = .idle
        var verb: String?
        var foundStatus = false
        var prompt: String?
        var response: String?
        var lastEntryAt: Date?

        for line in data.split(separator: 0x0A).reversed() {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            if branch == nil { branch = obj["gitBranch"] as? String }
            // Reverse pass, so the first timestamp we meet is the newest.
            if lastEntryAt == nil, let stamp = obj["timestamp"] as? String {
                lastEntryAt = timestamp(stamp)
            }

            switch obj["type"] as? String {
            case "assistant":
                guard let message = obj["message"] as? [String: Any],
                      let content = message["content"] as? [[String: Any]] else { break }
                if !foundStatus {
                    if let tool = content.last(where: { ($0["type"] as? String) == "tool_use" }),
                       let name = tool["name"] as? String {
                        // A pending tool_use is the last thing emitted: the turn is in
                        // progress (running it / awaiting its result).
                        status = agentEditTools.contains(name) ? .editing : .tool
                        verb = agentToolVerb(name)
                    } else if (message["stop_reason"] as? String) == "tool_use" {
                        // A thinking/text preamble whose turn continues with a tool in
                        // the following message (the tool_use block isn't in this one
                        // yet) — still in progress, not done.
                        status = .running
                        verb = "Thinking"
                    } else {
                        // A terminal assistant message (end_turn / max_tokens) ends the
                        // turn: nothing left to run, so the session is idle until the
                        // user speaks again.
                        status = .idle
                        verb = nil
                    }
                    foundStatus = true
                }
                if response == nil {
                    let text = content
                        .compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }
                        .joined(separator: " ")
                    if !text.isEmpty { response = agentClip(text) }
                }
            case "user":
                guard let message = obj["message"] as? [String: Any] else { break }
                // A slash command echoes itself into the transcript as user entries,
                // and `/clear` writes them into a brand-new one. They start no turn:
                // counting them as a prompt made every fresh chat read as running,
                // with "<command-name>/clear</command-name>" as its preview.
                if isLocalCommand(message) { break }
                if !foundStatus {
                    // Esc writes a "[Request interrupted by user]" user entry and no
                    // Stop hook ever fires, so without this the session lingers busy
                    // until the next action or process death.
                    if isInterrupt(message) {
                        status = .idle
                        verb = nil
                    } else {
                        status = .running
                        verb = "Thinking"
                    }
                    foundStatus = true
                }
                if prompt == nil, let text = userPrompt(message) {
                    prompt = agentClip(text)
                }
            default:
                break
            }
            if branch != nil && foundStatus && prompt != nil && response != nil && lastEntryAt != nil { break }
        }
        return TranscriptState(
            branch: branch, busy: status, verb: verb,
            prompt: prompt, response: response, lastEntryAt: lastEntryAt
        )
    }

    /// The synthetic user entry Claude writes when the user presses Esc mid-turn
    /// ("[Request interrupted by user]" / "...for tool use]"). Ends the turn.
    private static func isInterrupt(_ message: [String: Any]) -> Bool {
        userText(message)?.hasPrefix("[Request interrupted by user") == true
    }

    /// Claude's own echo of a slash command (and the caveat block it writes
    /// alongside), which the CLI logs as a user entry.
    private static let localCommandPrefixes = [
        "<command-name>", "<local-command-caveat>", "<local-command-stdout>",
    ]

    private static func isLocalCommand(_ message: [String: Any]) -> Bool {
        guard let text = userText(message)?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return false
        }
        return localCommandPrefixes.contains { text.hasPrefix($0) }
    }

    /// A user transcript entry is a real prompt only when it's something the user
    /// actually said: not tool output, not an interrupt marker, not a command echo.
    private static func userPrompt(_ message: [String: Any]) -> String? {
        guard !isInterrupt(message), !isLocalCommand(message) else { return nil }
        return userText(message)
    }

    /// The plain text of a user entry — the bare string form, or its `text`
    /// blocks joined. Nil for entries carrying a `tool_result`, which are tool
    /// output rather than anything the user wrote.
    private static func userText(_ message: [String: Any]) -> String? {
        if let string = message["content"] as? String {
            return string.isEmpty ? nil : string
        }
        guard let content = message["content"] as? [[String: Any]] else { return nil }
        if content.contains(where: { ($0["type"] as? String) == "tool_result" }) { return nil }
        let text = content
            .compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }
            .joined(separator: " ")
        return text.isEmpty ? nil : text
    }

    /// Entry timestamps are ISO-8601 with fractional seconds; tolerate the plain
    /// form too rather than losing the activity time to a format change.
    private static let fractionalISO8601 = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private static func timestamp(_ string: String) -> Date? {
        (try? Date(string, strategy: fractionalISO8601)) ?? (try? Date(string, strategy: .iso8601))
    }
}
