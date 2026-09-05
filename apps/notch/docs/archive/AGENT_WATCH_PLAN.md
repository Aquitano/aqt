# Notch — Watch Agents & Get Notifications

## Context

`notch` is a general-purpose macOS notch app (Now Playing, HUDs, tray, widgets, activities).
This adds a new capability: **watch AI coding agents and surface their status + notifications
in the notch**, for **Claude Code, Codex, and OpenCode**.

Technique reference: `devmegablaster/Notch-Pilot` (MIT) — we reuse its hard-won mechanisms
(same-binary hook, unix socket, `libproc` liveness, terminal jump) but adapt them to notch's
push-based, protocol+adapter architecture and to a lighter scope.

**Scope:**

- **Watch + notify only** — live session status in the pill + an Agents list; notifications for
  _started / needs-attention / finished_. **No** approve/deny buttons, no AskUserQuestion answering.
- **Opt-in config writes** — ship the installer but gate it behind a per-agent "Enable" button.
  Nothing is written to `~/.claude/settings.json` or `~/.codex/config.toml` until the user clicks.

**Non-goals this phase (designed to be addable later):** remote approve/deny, answering
questions, live usage %. The model carries enough (permission id, capabilities) to grow into these.

## Capability matrix (drives per-provider design)

| Agent           | Live events        | Needs-attention signal                                  | Finished signal                | Mechanism                                                                                    |
| --------------- | ------------------ | ------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| **Claude Code** | push (hooks)       | `Notification` hook (`permission_prompt`/`idle_prompt`) | `Stop` hook                    | opt-in fire-and-forget hooks → unix socket; transcript tail for activity; `libproc` liveness |
| **OpenCode**    | push (SSE)         | `permission.*` event                                    | `session.idle` event           | connect to `opencode serve` (`127.0.0.1:4096`) SSE `/event`; REST `/session` for detail      |
| **Codex**       | turn-complete only | — (not exposed)                                         | `notify` `agent-turn-complete` | opt-in `notify` program → socket; `~/.codex/sessions` + `libproc` for liveness/active        |

Honest constraint surfaced in the UI: Codex is finish-notification + liveness only; it has no
external "needs approval / is idle" event.

## Architecture (mirrors the existing `MediaControlling` adapter pattern)

`MediaManager` already picks a concrete `MediaControlling` at runtime and treats sources
uniformly. We replicate that exactly for agents.

- **Unified model** (`Model/Agents/AgentModels.swift`): `AgentKind` (.claudeCode/.codex/.openCode),
  `AgentSession` (id, kind, project, cwd, status, startedAt, lastActivity, pid?),
  `AgentStatus` (.running/.editing/.tool/.idle/.needsAttention/.finished), `AgentEvent`,
  `AgentProviderCapabilities` (OptionSet: `.liveEvents`, `.attention`, `.respondToPermissions`).
- **`AgentProviding` protocol** (`Managers/Agents/AgentProviding.swift`): `@MainActor`, mirrors
  `MediaControlling` — `var onSessions/onEvent: (...)->Void`, `capabilities`, `start()`, `stop()`,
  `isEnabled`, `enable()/disable()` (the latter two trigger the opt-in installer).
- **Providers** (`Managers/Agents/Providers/`): `ClaudeCodeProvider`, `OpenCodeProvider`,
  `CodexProvider`.
- **`AgentManager`** (`Managers/Agents/AgentManager.swift`, `@MainActor ObservableObject`):
  aggregates providers, owns `@Published sessions: [AgentSession]`, dedups/reconciles, and feeds
  `ActivityManager` (pill activity + peeks). Owned by `AppEnvironment`, injected into the env.
- **Shared services** (`Services/Agents/`):
  - `ProcessLookup` — thin `libproc` wrappers (`proc_listpids`/`proc_name`/`proc_pidpath`/
    `proc_pidinfo` for ppid + cwd; `normalize()` strips `/private`). Lifted from Notch-Pilot.
  - `AgentSocketServer` — line-delimited JSON over `~/.notch/agents.sock` (chmod 0600).
    **Fire-and-forget only** (no blocking/response dance — we don't approve), so far simpler
    than Notch-Pilot's. Peer PID via `LOCAL_PEERPID` to map session→claude pid.
  - `AgentConfigInstaller` — idempotent, reversible writes to `~/.claude/settings.json` (hooks)
    and `~/.codex/config.toml` (notify). Self-heals the app path; removes stale entries on disable.
  - `AgentNotifier` — routes a notification to `ActivityManager.peek()` (in-notch) and, when
    enabled, `UNUserNotificationCenter` + optional sound. Rate-limited.
- **Hook entry point**: replace SwiftUI `@main` with a manual entry that branches on argv
  _before_ AppKit loads (Notch-Pilot's trick):
  ```swift
  @main enum NotchMain {
      static func main() {
          switch CommandLine.arguments.dropFirst().first {
          case "--agent-hook":   HookClient.runClaude()   // reads stdin, writes socket, exit
          case "--codex-notify": HookClient.runCodex()    // reads argv JSON, writes socket, exit
          default:               NotchApp.main()           // the real app
          }
      }
  }
  ```
  `NotchApp` keeps its current `App`/`AppDelegate` body. The clients are tiny and never load the UI.

## Per-agent integration

- **Claude Code** — On enable, `AgentConfigInstaller` adds fire-and-forget hooks (`"<exe> --agent-hook"`)
  for `Notification`, `Stop`, `SessionStart`, `SessionEnd` (+ optionally `PreToolUse`/`UserPromptSubmit`
  for live activity + `permission_mode`). The `--agent-hook` client writes the event to the socket and
  exits 0 immediately (never blocks Claude). Status/activity from tailing
  `~/.claude/projects/**/*.jsonl` via FSEvents; liveness by matching live `claude` pids' cwd (`libproc`).
- **OpenCode** — On enable, if a server answers on `127.0.0.1:4096` (`/global/health`), subscribe to
  SSE `/event` with a streaming `URLSession.bytes(for:)` task; map `message.*`/`session.idle`/
  `permission.*` to status + attention; hydrate session detail from `GET /session`. If no server is
  running, show an inline hint ("run `opencode serve`"). No serve auto-start in watch mode.
  (Exact event-name strings confirmed at implement time by logging the stream / reading `/doc`.)
- **Codex** — On enable, add `notify = ["<exe>", "--codex-notify"]` to `~/.codex/config.toml`. The
  client forwards the `agent-turn-complete` JSON to the socket → "finished" notification. Active/idle
  and project derived from newest `~/.codex/sessions/**` rollout file + `libproc` liveness.

## UI (reuses existing surfaces)

- **Compact pill** — add `Activity.Kind.agent(kind:project:status:)` with `compactSymbol`/`compactLabel`
  (e.g. `"claude · editing"`, `"codex · done"`, `"opencode · needs you"`). `needsAttention` →
  `.urgent` priority (auto-shows the pill; optional auto-expand via setting). No new compact code path
  needed — `CompactView` already renders `activities.compactActivity`. Add channel key in
  `ActivityManager` (e.g. `agent.<sessionID>`) so updates replace rather than stack.
- **Expanded** — add `NotchState.ExpandedTab.agents` (terminal/CLI glyph). New `Views/Agents/AgentsView`
  lists session rows (agent glyph, project, status dot, uptime); tapping a row jumps to the hosting
  terminal (parent-chain walk + tmux pane select, adapted from `TerminalJumper`). Empty state shows
  per-agent **Enable** buttons that call `provider.enable()` (the opt-in installer).
- **Notifications** — `AgentNotifier` → in-notch peek always; `UNUserNotificationCenter` + sound when
  the user opts in. Events: started (low/off by default), needs-attention (Claude/OpenCode), finished.
- **Settings** (`ExpandedView` inline + `SettingsView`): master enable, per-agent enable (drives the
  installer), notify-on toggles, sound, auto-expand-on-attention. Added to `Settings.swift` UserDefaults.

## Honoring notch's invariants

- **No timers.** Socket, FSEvents, and SSE are all push. The one unavoidable poll — `libproc`
  liveness — is **event-triggered** (run only when a transcript/session file changes or a socket event
  arrives), plus a sparse reconcile, never a 1s loop.
- **Off-main heavy work** (process scans, file reads, SSE parsing) hops back to `@MainActor` to publish,
  like every other manager.
- **Not sandboxed** (per README) → file/process/socket/network access is available; confirm
  `Notch.entitlements` keeps sandbox off. New files are picked up by `xcodegen generate` (dir glob).

## Files

**Add:** `Model/Agents/AgentModels.swift`; `Managers/Agents/{AgentManager,AgentProviding}.swift`;
`Managers/Agents/Providers/{ClaudeCode,OpenCode,Codex}Provider.swift`;
`Services/Agents/{ProcessLookup,AgentSocketServer,AgentConfigInstaller,AgentNotifier}.swift`;
`App/HookClient.swift`; `Views/Agents/{AgentsView,AgentRowView}.swift`.

**Modify:** `App/NotchApp.swift` (argv branch), `App/AppEnvironment.swift` (own/start/inject
`AgentManager`), `Model/Activity.swift` (+`.agent`), `Managers/ActivityManager.swift` (channel key),
`State/NotchState.swift` (+`.agents` tab), `Views/ExpandedView.swift` (tab + toggles),
`Settings/Settings.swift` (prefs), `Views/Settings/SettingsView.swift`.

## Milestones

1. **Foundation** — model + `AgentManager` skeleton + `AgentProviding` + `AgentSocketServer` +
   `ProcessLookup` + argv branch. Wired into `AppEnvironment`, no providers; builds, no behavior change.
2. **Claude Code provider** — opt-in installer + `--agent-hook` client + transcript tail + liveness →
   pill status + peeks.
3. **UI** — `.agents` tab + session rows + jump-to-terminal + settings toggles + `AgentNotifier`.
4. **Codex provider** — notify installer + `--codex-notify` client + sessions liveness (finish-notify).
5. **OpenCode provider** — SSE subscription + REST session detail + attention.
6. **Polish** — `UNUserNotificationCenter` + sound + rate-limiting, occlusion behavior, reconcile edges.

## Verification

- **Build:** `cd notch && xcodegen generate && xcodebuild -project Notch.xcodeproj -scheme Notch -configuration Debug build` (or run in Xcode).
- **Claude Code:** Agents tab → Enable → confirm hook block appears in `~/.claude/settings.json`; run
  `claude` in a project → pill shows live status; trigger a permission prompt → needs-attention peek;
  finish a turn → finished notification; click the row → terminal comes to front.
- **Codex:** Enable → confirm `notify` line in `~/.codex/config.toml`; run a task → finished notification.
- **OpenCode:** `opencode serve` → Enable → live status + attention; stop server → inline hint shown.
- **Reversibility:** Disable each → config entries removed.
- **Idle cost:** no agents running → no measurable CPU (confirms no polling regressions).

## References

- Claude Code hooks: https://code.claude.com/docs/en/hooks
- OpenCode server API: https://opencode.ai/docs/server/
- Codex `notify` config: https://developers.openai.com/codex/config-advanced
- Technique reference: https://github.com/devmegablaster/Notch-Pilot (MIT)
