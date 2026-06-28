import Foundation

/// Idempotent, reversible writes to agent config files. Enabling installs this
/// app's hook entries; disabling removes only our entries (identified by the
/// `--agent-hook` marker) and prunes anything left empty.
///
/// Config is often a dotfiles-managed symlink. We write through to the real
/// target so the atomic temp+rename replaces the file's contents instead of
/// clobbering the symlink with a plain file.
struct AgentConfigInstaller {

    enum InstallerError: Error {
        /// The file exists but could not be read or parsed as a JSON object;
        /// we refuse to overwrite it (that would destroy the user's settings).
        case settingsUnreadable
        /// `hooks` exists but is not a JSON object; refuse to clobber it.
        case unexpectedHooksShape
    }

    private let home = FileManager.default.homeDirectoryForCurrentUser
    private var claudeSettingsURL: URL { home.appendingPathComponent(".claude/settings.json") }
    private var bridgeDir: URL { home.appendingPathComponent(".notch/bin", isDirectory: true) }
    private var bridgeURL: URL { bridgeDir.appendingPathComponent("notch-agent-hook") }
    private var appPathCacheURL: URL { bridgeDir.appendingPathComponent(".app-path") }
    private var statusLineURL: URL { bridgeDir.appendingPathComponent("notch-statusline") }
    private var statusLineOrigURL: URL { bridgeDir.appendingPathComponent(".statusline-orig.json") }

    private var codexHooksURL: URL { home.appendingPathComponent(".codex/hooks.json") }
    private var openCodePluginURL: URL { home.appendingPathComponent(".config/opencode/plugins/notch.js") }
    private var ohMyPiDir: URL { home.appendingPathComponent(".omp/agent/extensions/notch", isDirectory: true) }

    private static let claudeHookEvents = ["Notification", "Stop", "SessionStart", "SessionEnd"]
    private static let codexHookEvents = ["PermissionRequest", "PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]
    /// Substring identifying our hook entries — matches both the stable-path
    /// launcher (`notch-agent-hook`) and any legacy `… --agent-hook` command.
    private static let hookMarker = "agent-hook"

    /// Defensive call to our stable-path launcher that locates the app and execs
    /// the hook tool. Never blocks the agent. `--source` selects the parser.
    private func launcherCommand(source: String?) -> String {
        let suffix = source.map { " --source \($0)" } ?? ""
        return "/bin/sh -c '[ -x \"$HOME/.notch/bin/notch-agent-hook\" ] && \"$HOME/.notch/bin/notch-agent-hook\"\(suffix); exit 0'"
    }

    // MARK: - Bridge launcher (stable path)

    /// Write the launcher script + record the app's current bundle path so the
    /// launcher resolves the running build (including dev builds) without the
    /// config ever referencing a volatile path.
    func writeBridge() throws {
        try FileManager.default.createDirectory(
            at: bridgeDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        try bridgeScript.write(to: bridgeURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bridgeURL.path)
        try? Bundle.main.bundlePath.write(to: appPathCacheURL, atomically: true, encoding: .utf8)
    }

    private var bridgeScript: String {
        """
        #!/bin/sh
        # notch agent hook launcher (auto-generated, do not edit)
        # Prefer the lightweight bundled tool; fall back to the app's --agent-hook.
        run() {
          app="$1"; shift
          [ -x "$app/Contents/Resources/notch-hook" ] && exec "$app/Contents/Resources/notch-hook" "$@"
          [ -x "$app/Contents/MacOS/Notch" ] && exec "$app/Contents/MacOS/Notch" --agent-hook "$@"
        }
        C="$HOME/.notch/bin/.app-path"
        [ -f "$C" ] && read -r P < "$C" && run "$P" "$@"
        run "/Applications/Notch.app" "$@"
        P="$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.aquitano.notch"' 2>/dev/null | /usr/bin/head -1)"
        [ -n "$P" ] && { printf '%s' "$P" > "$C"; run "$P" "$@"; }
        exit 0
        """
    }

    // MARK: - Claude

    func claudeHooksInstalled() -> Bool {
        hasCommand(at: claudeSettingsURL, events: Self.claudeHookEvents, containing: Self.hookMarker)
    }

    /// True when the *stable-path launcher* is installed (vs. a legacy command
    /// that hard-codes the app path), so start() can upgrade old installs once.
    func claudeBridgeInstalled() -> Bool {
        hasCommand(at: claudeSettingsURL, events: Self.claudeHookEvents, containing: "notch-agent-hook")
    }

    /// Install the launcher and add our hook to each Claude event. Throws — rather
    /// than overwriting — if the existing file is present but unparseable, so a
    /// transient read error or a manual JSON slip can never wipe the user's config.
    func installClaudeHooks() throws {
        try writeBridge()
        try installHooks(at: claudeSettingsURL, events: Self.claudeHookEvents, command: launcherCommand(source: nil))
    }

    func removeClaudeHooks() throws {
        try removeHooks(at: claudeSettingsURL, events: Self.claudeHookEvents)
    }

    // MARK: - Codex (~/.codex/hooks.json)

    func codexHooksInstalled() -> Bool {
        hasCommand(at: codexHooksURL, events: Self.codexHookEvents, containing: "notch-agent-hook")
    }

    func installCodexHooks() throws {
        try writeBridge()
        try installHooks(at: codexHooksURL, events: Self.codexHookEvents,
                         command: launcherCommand(source: "codex"), timeout: 5)
    }

    func removeCodexHooks() throws {
        try removeHooks(at: codexHooksURL, events: Self.codexHookEvents)
    }

    // MARK: - OpenCode (JS plugin) & oh-my-pi (extension)

    func openCodePluginInstalled() -> Bool { FileManager.default.fileExists(atPath: openCodePluginURL.path) }

    func installOpenCodePlugin() throws {
        try FileManager.default.createDirectory(
            at: openCodePluginURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try Self.openCodePluginJS.write(to: openCodePluginURL, atomically: true, encoding: .utf8)
    }

    func removeOpenCodePlugin() throws { try? FileManager.default.removeItem(at: openCodePluginURL) }

    func ohMyPiInstalled() -> Bool {
        FileManager.default.fileExists(atPath: ohMyPiDir.appendingPathComponent("index.js").path)
    }

    func installOhMyPi() throws {
        try FileManager.default.createDirectory(at: ohMyPiDir, withIntermediateDirectories: true)
        try Self.ohMyPiPackageJSON.write(to: ohMyPiDir.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try Self.ohMyPiIndexJS.write(to: ohMyPiDir.appendingPathComponent("index.js"), atomically: true, encoding: .utf8)
    }

    func removeOhMyPi() throws { try? FileManager.default.removeItem(at: ohMyPiDir) }

    // MARK: - Claude usage limits (statusLine wrapper, preserves the user's own)

    func claudeUsageInstalled() -> Bool {
        guard case let .object(root) = readSettings(at: claudeSettingsURL),
              let line = root["statusLine"] as? [String: Any],
              let command = line["command"] as? String else { return false }
        return command.contains("notch-statusline")
    }

    /// Wrap the user's statusLine so we tee `rate_limits` to the socket while
    /// still running their original command (e.g. ccstatusline) unchanged.
    func installClaudeUsage() throws {
        try writeBridge()
        var root: [String: Any]
        switch readSettings(at: claudeSettingsURL) {
        case .missing: root = [:]
        case .object(let obj): root = obj
        case .unreadable: throw InstallerError.settingsUnreadable
        }

        let existing = root["statusLine"] as? [String: Any]
        let currentCommand = existing?["command"] as? String ?? ""
        if currentCommand.contains("notch-statusline") {
            try writeStatusLineWrapper(original: savedOriginalCommand())
            return
        }

        if let existing { try? writeJSONFile(existing, to: statusLineOrigURL) }
        else { try? FileManager.default.removeItem(at: statusLineOrigURL) }
        try writeStatusLineWrapper(original: currentCommand.isEmpty ? nil : currentCommand)

        var line = existing ?? [:]
        line["type"] = "command"
        line["command"] = statusLineURL.path
        root["statusLine"] = line
        try writeJSON(root, to: claudeSettingsURL)
    }

    func removeClaudeUsage() throws {
        guard case var .object(root) = readSettings(at: claudeSettingsURL),
              let line = root["statusLine"] as? [String: Any],
              (line["command"] as? String)?.contains("notch-statusline") == true else { return }
        if let original = readJSONFile(statusLineOrigURL) {
            root["statusLine"] = original
        } else {
            root["statusLine"] = nil
        }
        try writeJSON(root, to: claudeSettingsURL)
        try? FileManager.default.removeItem(at: statusLineURL)
        try? FileManager.default.removeItem(at: statusLineOrigURL)
    }

    private func writeStatusLineWrapper(original: String?) throws {
        try FileManager.default.createDirectory(
            at: bridgeDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        // Run the original command on the same stdin so the user's status line is
        // unchanged; "true" when there was none.
        let runOriginal = original.map { "printf '%s' \"$in\" | \($0)" } ?? "true"
        let script = """
        #!/bin/sh
        # notch-statusline (auto-generated, do not edit) — tee rate_limits, then run the original
        in="$(cat)"
        printf '%s' "$in" | "$HOME/.notch/bin/notch-agent-hook" --source statusline >/dev/null 2>&1 &
        \(runOriginal)
        """
        try script.write(to: statusLineURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: statusLineURL.path)
    }

    private func savedOriginalCommand() -> String? {
        readJSONFile(statusLineOrigURL)?["command"] as? String
    }

    private func writeJSONFile(_ object: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted])
        try data.write(to: url, options: .atomic)
    }

    private func readJSONFile(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: - Generic hook merge (Claude settings.json + Codex hooks.json share the format)

    private func installHooks(at url: URL, events: [String], command: String, timeout: Int? = nil) throws {
        var root: [String: Any]
        switch readSettings(at: url) {
        case .missing: root = [:]
        case .object(let obj): root = obj
        case .unreadable: throw InstallerError.settingsUnreadable
        }

        var hooks: [String: Any]
        switch root["hooks"] {
        case .none: hooks = [:]
        case let existing as [String: Any]: hooks = existing
        default: throw InstallerError.unexpectedHooksShape
        }

        for event in events {
            if let existing = hooks[event] {
                guard let groups = existing as? [[String: Any]] else { continue } // leave malformed value
                hooks[event] = pruneMarker(from: groups) + [ourGroup(command, timeout: timeout)]
            } else {
                hooks[event] = [ourGroup(command, timeout: timeout)]
            }
        }
        root["hooks"] = hooks
        try writeJSON(root, to: url)
    }

    private func removeHooks(at url: URL, events: [String]) throws {
        guard case var .object(root) = readSettings(at: url),
              var hooks = root["hooks"] as? [String: Any] else { return }
        for event in events {
            guard let groups = hooks[event] as? [[String: Any]] else { continue }
            let pruned = pruneMarker(from: groups)
            if pruned.isEmpty { hooks[event] = nil } else { hooks[event] = pruned }
        }
        if hooks.isEmpty { root["hooks"] = nil } else { root["hooks"] = hooks }
        try writeJSON(root, to: url)
    }

    private func hasCommand(at url: URL, events: [String], containing needle: String) -> Bool {
        guard case let .object(root) = readSettings(at: url),
              let hooks = root["hooks"] as? [String: Any] else { return false }
        return events.contains { event in
            commands(inEvent: hooks[event]).contains { $0.contains(needle) }
        }
    }

    // MARK: - Hook shaping

    private func ourGroup(_ command: String, timeout: Int? = nil) -> [String: Any] {
        var hook: [String: Any] = ["type": "command", "command": command]
        if let timeout { hook["timeout"] = timeout }
        return ["hooks": [hook]]
    }

    /// Strip only our marker commands, at inner-hook granularity, so a group that
    /// also holds a user's hook keeps that hook (the group is dropped only if it
    /// becomes empty).
    private func pruneMarker(from groups: [[String: Any]]) -> [[String: Any]] {
        groups.compactMap { group in
            guard var inner = group["hooks"] as? [[String: Any]] else { return group }
            inner.removeAll { ($0["command"] as? String)?.contains(Self.hookMarker) == true }
            if inner.isEmpty { return nil }
            var pruned = group
            pruned["hooks"] = inner
            return pruned
        }
    }

    // MARK: - JSON I/O

    private enum ReadResult {
        case missing
        case object([String: Any])
        case unreadable
    }

    private func readSettings(at url: URL) -> ReadResult {
        guard FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let data = try? Data(contentsOf: url) else { return .unreadable }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .unreadable
        }
        return .object(object)
    }

    private func writeJSON(_ object: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        let target = resolvedTarget(of: url)
        try FileManager.default.createDirectory(
            at: target.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: target, options: .atomic)
    }

    /// Follow a chain of symlinks to the real file path (bounded). Returns `url`
    /// unchanged when it is not a symlink or does not exist yet.
    private func resolvedTarget(of url: URL) -> URL {
        let fm = FileManager.default
        var current = url
        for _ in 0..<8 {
            guard let dest = try? fm.destinationOfSymbolicLink(atPath: current.path) else { break }
            if (dest as NSString).isAbsolutePath {
                current = URL(fileURLWithPath: dest).standardizedFileURL
            } else {
                current = current.deletingLastPathComponent()
                    .appendingPathComponent(dest).standardizedFileURL
            }
        }
        return current
    }

    // MARK: - Hook parsing

    private func commands(inEvent value: Any?) -> [String] {
        guard let groups = value as? [[String: Any]] else { return [] }
        return groups.flatMap { group -> [String] in
            guard let inner = group["hooks"] as? [[String: Any]] else { return [] }
            return inner.compactMap { $0["command"] as? String }
        }
    }

    // MARK: - Generated plugin / extension sources

    /// OpenCode auto-loads every file in its plugins dir. This forwards the bus
    /// events we care about to ~/.notch/agents.sock as one normalized envelope
    /// per event. Written fresh (not copied from any proprietary plugin).
    private static let openCodePluginJS = #"""
    // notch agent watcher — auto-generated, do not edit
    import { Socket } from "net";
    import { homedir } from "os";
    import { join } from "path";

    const SOCKET = join(homedir(), ".notch", "agents.sock");

    function send(record) {
      return new Promise((resolve) => {
        let done = false;
        const fin = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
        const sock = new Socket();
        sock.on("error", () => fin(false));
        sock.setTimeout(2000, () => fin(false));
        sock.on("connect", () => { try { sock.write(JSON.stringify(record) + "\n"); sock.end(); resolve(true); } catch { fin(false); } });
        sock.connect({ path: SOCKET });
      });
    }

    export default async ({ directory }) => {
      const pid = process.pid;
      const sessions = new Map();
      const roles = new Map();
      const get = (id) => { if (!sessions.has(id)) sessions.set(id, { cwd: directory, prompt: "", response: "", model: "", parent: "" }); return sessions.get(id); };
      const emit = (id, status, extra = {}) => {
        const s = get(id);
        return send({ agent: "openCode", hook: extra.event || status, status, sessionId: id, cwd: s.cwd, pid,
          prompt: s.prompt || undefined, response: s.response || undefined, model: s.model || undefined, tool: extra.tool, parent: s.parent || undefined });
      };
      return {
        event: async ({ event }) => {
          const t = event && event.type;
          const p = (event && event.properties) || {};
          if ((t === "session.created" || t === "session.updated") && p.info && p.info.id) {
            const s = get(p.info.id);
            if (p.info.directory) s.cwd = p.info.directory;
            if (p.info.parentID) s.parent = p.info.parentID;
            if (p.info.time && p.info.time.archived) return emit(p.info.id, "ended", { event: t });
            return emit(p.info.id, "idle", { event: t });
          }
          if (t === "session.deleted" && p.info && p.info.id) { await emit(p.info.id, "ended", { event: t }); sessions.delete(p.info.id); return; }
          if (t === "session.idle" && p.sessionID) return emit(p.sessionID, "idle", { event: t });
          if (t === "message.updated" && p.info && p.info.id) {
            roles.set(p.info.id, { role: p.info.role, sessionID: p.info.sessionID });
            if (p.info.role === "assistant" && p.info.modelID) get(p.info.sessionID).model = p.info.modelID;
            if (p.info.finish === "stop" && p.info.sessionID) return emit(p.info.sessionID, "idle", { event: t });
            return;
          }
          if (t === "message.part.updated" && p.part) {
            const part = p.part;
            if (part.type === "text" && part.messageID) {
              const meta = roles.get(part.messageID);
              if (!meta || !meta.sessionID) return;
              const s = get(meta.sessionID);
              if (meta.role === "user" && part.text) { s.prompt = part.text; return emit(meta.sessionID, "busy", { event: "prompt" }); }
              if (meta.role === "assistant" && part.text) s.response = part.text;
              return;
            }
            if (part.type === "tool" && part.sessionID) {
              const st = part.state && part.state.status;
              if (st === "running" || st === "pending") return emit(part.sessionID, "busy", { event: "tool", tool: part.tool });
              return;
            }
          }
          if (t === "permission.asked" && p.sessionID) return emit(p.sessionID, "waiting", { event: t, tool: p.permission });
          if (t === "permission.replied" && p.sessionID) return emit(p.sessionID, "busy", { event: t });
        },
      };
    };
    """#

    private static let ohMyPiPackageJSON = #"""
    {
      "name": "notch-omp-extension",
      "private": true,
      "type": "module",
      "main": "index.js",
      "omp": { "extensions": ["./index.js"] },
      "pi": { "extensions": ["./index.js"] }
    }
    """#

    /// oh-my-pi (omp) loads extensions via a `pi.on(event, handler)` API.
    private static let ohMyPiIndexJS = #"""
    // notch agent watcher — auto-generated, do not edit
    import net from "node:net";
    import os from "node:os";
    import path from "node:path";

    const SOCK = path.join(os.homedir(), ".notch/agents.sock");

    function send(payload) {
      return new Promise((resolve) => {
        let done = false;
        const fin = (ok) => { if (done) return; done = true; resolve(ok); };
        const s = net.connect(SOCK);
        s.on("error", () => fin(false));
        s.on("connect", () => s.end(JSON.stringify(payload) + "\n"));
        s.on("close", () => fin(true));
        setTimeout(() => { try { s.destroy(); } catch {} fin(false); }, 2000).unref();
      });
    }
    function sid(ctx) { return String((ctx && ctx.sessionManager && ctx.sessionManager.getSessionId && ctx.sessionManager.getSessionId()) || "unknown"); }
    function cwd(ctx) { return (ctx && ctx.cwd) || (ctx && ctx.sessionManager && ctx.sessionManager.getCwd && ctx.sessionManager.getCwd()); }
    function text(m) {
      const c = m && m.content;
      if (typeof c === "string") return c || undefined;
      if (!Array.isArray(c)) return undefined;
      const t = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
      return t.length ? t.join("\n") : undefined;
    }
    function lastAssistant(ms) {
      if (!Array.isArray(ms)) return {};
      for (let i = ms.length - 1; i >= 0; i--) {
        const m = ms[i];
        if (!m || m.role !== "assistant") continue;
        const t = text(m);
        if (!t) continue;
        return { text: t, model: typeof m.model === "string" ? m.model : undefined };
      }
      return {};
    }
    const base = (ctx, hook, status) => ({ agent: "ohMyPi", hook, status, sessionId: sid(ctx), cwd: cwd(ctx), pid: process.pid });
    const safe = (fn) => async (...a) => { try { await fn(...a); } catch {} };

    export default function activate(pi) {
      pi.on("session_start", safe(async (_e, ctx) => send(base(ctx, "session_start", "started"))));
      pi.on("message_start", safe(async (e, ctx) => { if (!e.message || e.message.role !== "user") return; const p = text(e.message); if (!p) return; await send({ ...base(ctx, "prompt", "busy"), prompt: p }); }));
      pi.on("agent_start", safe(async (_e, ctx) => send({ ...base(ctx, "agent_start", "busy"), model: ctx.model && ctx.model.id })));
      pi.on("tool_call", safe(async (e, ctx) => {
        if (e.toolName !== "ask" && e.toolName !== "AskUserQuestion") return;
        const qs = Array.isArray(e.input && e.input.questions) ? e.input.questions : [];
        const msg = qs.map((q) => q && q.question).filter(Boolean).join(" / ");
        await send({ ...base(ctx, "ask", "waiting"), message: msg || undefined });
      }));
      pi.on("tool_result", safe(async (e, ctx) => { if (e.toolName !== "ask" && e.toolName !== "AskUserQuestion") return; await send(base(ctx, "ask_resolved", "busy")); }));
      pi.on("agent_end", safe(async (e, ctx) => { const r = lastAssistant(e.messages); await send({ ...base(ctx, "agent_end", "finished"), response: r.text, model: r.model }); }));
      pi.on("session_shutdown", safe(async (_e, ctx) => send(base(ctx, "session_shutdown", "ended"))));
    }
    """#
}
