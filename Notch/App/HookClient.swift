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
            pid: getppid()
        ))
        exit(0)
    }

    /// `Notch --codex-notify` — Codex notify program. The event JSON is the last
    /// argument Codex appends (`type` == "agent-turn-complete", ...).
    static func runCodex() -> Never {
        let payload = CommandLine.arguments.last ?? "{}"
        let json = (payload.data(using: .utf8)
            .flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] ?? [:]

        send(HookEnvelope(
            agent: AgentKind.codex.rawValue,
            hook: (json["type"] as? String) ?? "unknown",
            sessionId: json["turn-id"] as? String,
            cwd: json["cwd"] as? String,
            transcriptPath: nil,
            message: json["last-assistant-message"] as? String,
            pid: getppid()
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

        let path = AgentSocketServer.socketURL.path
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

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, len)
            }
        }
        guard connected == 0 else { return } // app not running: skip silently

        line.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
    }
}
