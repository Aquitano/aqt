import Foundation

/// What one reverse pass over a Claude transcript tail tells us: whether the
/// turn is still in progress (and doing what), the git branch, and the latest
/// prompt/response for the expanded preview.
struct TranscriptState: Equatable, Sendable {
    var branch: String?
    /// Busy-vs-idle inferred from the transcript structure (a pending `tool_use`
    /// or an unanswered prompt is busy; a text-only final turn is idle).
    var busy: AgentStatus
    var verb: String?
    var prompt: String?
    var response: String?
}

/// Parses Claude's `*.jsonl` transcripts into a `TranscriptState`. Operates on
/// the raw tail bytes, never a path — so it's exercisable with fixtures and has
/// no dependency on a live session on disk. The file I/O that produces those
/// bytes lives in `ProcessScanner`.
enum TranscriptParser {

    /// One reverse pass over the transcript tail collecting branch, busy status,
    /// the latest user prompt, and the latest assistant reply. Lines that aren't
    /// valid JSON objects are skipped; empty input yields the `.running` default.
    static func parse(_ data: Data) -> TranscriptState {
        var branch: String?
        var status: AgentStatus = .running
        var verb: String?
        var foundStatus = false
        var prompt: String?
        var response: String?

        for line in data.split(separator: 0x0A).reversed() {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            if branch == nil { branch = obj["gitBranch"] as? String }

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
                if !foundStatus { status = .running; verb = "Thinking"; foundStatus = true }
                if prompt == nil, let message = obj["message"] as? [String: Any],
                   let text = userPrompt(message) {
                    prompt = agentClip(text)
                }
            default:
                break
            }
            if branch != nil && foundStatus && prompt != nil && response != nil { break }
        }
        return TranscriptState(branch: branch, busy: status, verb: verb, prompt: prompt, response: response)
    }

    /// A user transcript entry is a real prompt only when its content is plain
    /// text — entries carrying a `tool_result` are tool output, not prompts.
    private static func userPrompt(_ message: [String: Any]) -> String? {
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
}
