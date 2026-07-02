import Darwin
import Foundation

/// Argv-dispatched clients that run in place of the app when the binary is
/// invoked as a Claude hook or Codex notify program (see `NotchMain`). They
/// never load AppKit/SwiftUI: read the event, write one JSON line to the agent
/// socket, exit. Every failure path is swallowed and exits 0 so the host agent
/// is never blocked, slowed, or made to fail by us.
enum HookClient {

    /// `Notch --agent-hook` — Claude Code fire-and-forget hook. Event JSON arrives
    /// on stdin (`hook_event_name`, `session_id`, `cwd`, `transcript_path`, ...).
    static func runClaude() -> Never {
        let input = readStdin()
        let json = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]

        send(HookEnvelope(
            agent: AgentKind.claudeCode.rawValue,
            hook: (json["hook_event_name"] as? String) ?? "unknown",
            sessionId: json["session_id"] as? String,
            cwd: json["cwd"] as? String,
            transcriptPath: json["transcript_path"] as? String,
            message: json["message"] as? String,
            pid: getppid(),
            // Present on PreToolUse/PostToolUse; lets the provider name the live verb
            // ("Running Bash", "Editing") straight from the event.
            tool: json["tool_name"] as? String
        ))
        exit(0)
    }

    /// Dispatch by `--source` (used by both the app's argv branch and the tool).
    static func dispatch(_ arguments: [String]) -> Never {
        if let index = arguments.firstIndex(of: "--source"), index + 1 < arguments.count {
            switch arguments[index + 1] {
            case "codex": runCodexHook()
            case "statusline": runStatusLine()
            default: runClaude()
            }
        }
        runClaude()
    }

    /// `--source statusline` — fed Claude's statusLine stdin JSON (which carries
    /// account-wide `rate_limits`). Forwards usage to the socket; prints nothing.
    static func runStatusLine() -> Never {
        let input = readStdin()
        let json = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]
        // No rate_limits in this refresh → nothing to report (don't overwrite with 0%).
        guard let limits = json["rate_limits"] as? [String: Any] else { exit(0) }
        let fiveHour = limits["five_hour"] as? [String: Any]
        let sevenDay = limits["seven_day"] as? [String: Any]

        send(HookEnvelope(
            agent: "usage", hook: "statusline", sessionId: json["session_id"] as? String,
            pid: getppid(), status: "usage",
            fiveHourUsed: fiveHour?["used_percentage"] as? Double,
            sevenDayUsed: sevenDay?["used_percentage"] as? Double,
            fiveHourResetsAt: (fiveHour?["resets_at"] as? NSNumber)?.doubleValue,
            sevenDayResetsAt: (sevenDay?["resets_at"] as? NSNumber)?.doubleValue
        ))
        exit(0)
    }

    /// Codex hooks.json command — event JSON on stdin (`hook_event_name`,
    /// `session_id`, `cwd`, `tool_name`, `tool_input`, `prompt`,
    /// `last_assistant_message`). Mapped to a normalized status envelope.
    static func runCodexHook() -> Never {
        let input = readStdin()
        let json = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]
        let event = (json["hook_event_name"] as? String) ?? "unknown"
        let toolName = json["tool_name"] as? String
        let toolInput = json["tool_input"] as? [String: Any]

        var status = "busy"
        var message: String?
        var prompt: String?
        var response: String?
        switch event {
        case "SessionStart": status = "started"
        case "UserPromptSubmit": status = "busy"; prompt = json["prompt"] as? String
        case "PostToolUse": status = "tool"
        case "PermissionRequest": status = "waiting"; message = (toolInput?["description"] as? String) ?? toolName
        case "Stop": status = "finished"; response = json["last_assistant_message"] as? String
        default: break
        }

        send(HookEnvelope(
            agent: AgentKind.codex.rawValue,
            hook: event,
            sessionId: json["session_id"] as? String,
            cwd: json["cwd"] as? String,
            transcriptPath: json["transcript_path"] as? String,
            message: message,
            pid: getppid(),
            status: status,
            tool: toolName,
            prompt: prompt,
            response: response,
            model: json["model"] as? String
        ))
        exit(0)
    }

    // MARK: - Plumbing

    private static func readStdin() -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(0, &buffer, buffer.count)
            guard n > 0 else { break }
            data.append(contentsOf: buffer[0..<n])
            if data.count > 1 << 20 { break }
        }
        return data
    }

    private static func send(_ envelope: HookEnvelope) {
        guard var line = try? JSONEncoder().encode(envelope) else { return }
        line.append(0x0A)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        defer { close(fd) }

        // If the app closes its end mid-write, write() would otherwise raise
        // SIGPIPE and terminate us with a non-zero exit — which the host agent
        // sees as a failed hook. Suppress it so the failure stays swallowed.
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        let path = AgentSocket.url.path
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = path.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { return }
        withUnsafeMutablePointer(to: &addr.sun_path) { dst in
            dst.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dstC in
                pathBytes.withUnsafeBufferPointer { src in
                    dstC.update(from: src.baseAddress!, count: pathBytes.count)
                }
            }
        }

        // Bound connect(): once the app's listen backlog fills, a blocking connect
        // has no timeout and would stall the host agent's turn (the hook entry may
        // carry no timeout of its own). Connect non-blocking, then poll briefly.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, len)
            }
        }
        if rc != 0 {
            guard errno == EINPROGRESS else { return } // app not running: skip silently
            var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            guard poll(&pfd, 1, 2000) == 1, pfd.revents & Int16(POLLOUT) != 0 else { return }
            var soError: Int32 = 0
            var soLen = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &soError, &soLen) == 0, soError == 0 else { return }
        }

        // Restore blocking with a send timeout so a stalled write can't hang either.
        _ = fcntl(fd, F_SETFL, flags)
        var sendTimeout = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))

        line.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
    }
}
