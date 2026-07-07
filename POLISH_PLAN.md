# Polish Plan — remaining work

Continuation plan for the feature/UX round started on `code-review-fixes-2026-07-02`
(2026-07-06). Tasks 1–3 of the round are done and verified; this file plans the rest.
Build/test commands are at the bottom.

## Already landed on this branch (uncommitted)

- Small fixes: settings-window height mismatch, Home-tab empty state, doc "no timers"
  claim corrected.
- Error surfaces: agent enable/install failures shown in Settings (`AgentManager.integrationError`),
  weather failed-fetch state with Retry (`WeatherManager.fetchFailed`), media adapter
  fallback reason in Settings (`MediaManager.adapterState`), `InstallerError` is `LocalizedError`.
- Agent-watch v2: interrupt stuck-busy fix (`TranscriptParser` treats
  `[Request interrupted by user…]` as idle), in-notch PermissionRequest approval
  (blocking hook → socket request/response → Approve/Deny in the agent row; opt-in via
  `agentPermissionApproval`, off by default). Round-trip verified against a mock socket.
  84 unit tests green.

Nothing is committed yet — commit in logical chunks before continuing (small fixes /
error surfaces / agent-watch v2 / onboarding).

## 1. Onboarding (task #4 — in progress, ~60% done)

Done so far:
- `Settings.hasCompletedOnboarding` (default false).
- `Notch/Views/Onboarding/OnboardingView.swift`: welcome header, permission rows
  (Calendar / Location / Focus with live status + Enable), launch-at-login and
  agents toggles, Get Started button. 440×560, standard window styling.

Remaining:
- **AppDelegate wiring**: `onboardingWindow: NSWindow?` +
  `showOnboarding()` (NSHostingController + `injectNotchEnvironment(env)`, titled,
  `.titled/.closable/.fullSizeContentView`, `isReleasedWhenClosed = false`, center,
  activate). Call from `applicationDidFinishLaunching` when
  `!env.settings.hasCompletedOnboarding`. `onFinish` closes the window.
- **Re-entry point**: "Show Welcome Tour" button in Settings → General section
  (needs a way for SettingsView to reach AppDelegate — simplest: post a
  `Notification.Name.showOnboarding` that AppDelegate observes, matching the app's
  push-based style).
- Permission rows update live when granted mid-flow (managers publish authorization;
  verify `weather.authorization` updates after the system dialog without relaunch).
- Verify: `rm`-reset the defaults key, launch, complete the tour, relaunch → no tour.
  `defaults delete com.aquitano.notch hasCompletedOnboarding` to re-test.

## 2. Keyboard & accessibility (task #5)

- **Global hotkey to toggle the notch**: Carbon `RegisterEventHotKey` wrapper
  (`Services/HotKey.swift`), default ⌃⌥N, stored as keyCode+modifiers in Settings;
  action = `state.expand()` / `state.hide()` (same as the status-item toggle).
  Recording UI in Settings → General (a small key-capture field; keep it minimal —
  fixed default + on/off toggle is an acceptable first cut).
- **VoiceOver expansion path**: the pill is currently hover-only. Give the compact
  view an accessibility action ("Expand notch") that calls `state.expand()`, and the
  expanded chrome a "Collapse" action; verify tab strip and rows are reachable in
  VoiceOver once expanded (labels already exist).
- **Dynamic Type pass**: views use fixed point sizes. Scope: map the main text styles
  to relative fonts (`.system(size:)` → `.font(.callout)/.caption` etc.) in
  AgentRowView, widget tiles, and MediaPlayerView; anything geometry-critical
  (pill, HUD) may stay fixed — note it in code.
- Verify: hotkey toggles with another app frontmost; VoiceOver (⌘F5) can expand,
  navigate tabs, activate Approve/Deny; text still fits at larger accessibility sizes.

## 3. Media adapter experience (task #6)

- **Guided setup instead of hand-bundling**: an "Install adapter…" affordance in
  Settings → Media when `adapterState == .unavailable` because the bridge is missing.
  Flow: explain what it is → download the pinned mediaremote-adapter release
  (hardcoded URL + SHA-256, verify before use) into `~/Library/Application Support/Notch/adapter/`
  → `AdapterMediaController` learns a second lookup path (Application Support first,
  bundle second). Never auto-download; explicit user click, checksum-verified, and a
  Remove button for reversibility.
- **Fork drift**: the control sub-command strings are fork-dependent; keep them in one
  `AdapterCommands` struct with a doc comment instead of scattered literals so a fork
  change is a one-place edit.
- **Visual extras (optional, after the above)**: audio-format badge (sample rate /
  codec if the adapter exposes it), simple level visualizer behind the artwork.
  Respect Reduce Motion (static bars) like the existing equalizer does.
- Verify: fresh machine path — no adapter → Settings shows install offer → install →
  relaunch → `adapterState == .active` and system-wide media appears; Remove reverts
  to scripting.

## 4. New widgets (task #7)

Ship in this order; each is a settings-gated tile in `WidgetGridView`.

- **Clock**: `ClockWidgetView` using the existing `clockString` helper; scoped
  `TimelineView(.everyMinute)` so it only ticks while the expanded surface is
  rendered (same pattern as TimerManager's pill tick). Optional second time zone.
- **Shortcuts runner**: `ShortcutsManager` shells out to `/usr/bin/shortcuts run
  <name>` off-main; Settings stores a small list of pinned shortcut names
  (`shortcuts list` to populate a picker). Tile shows pinned shortcuts as buttons;
  errors surface via the existing activity peek channel.
- **Quick notes**: smallest useful cut — one persistent scratch note
  (`Persistence`-backed string, TextEditor in a tile). No list, no sync.
- Each: settings toggle in Widgets section + empty-state handling (the Home-tab
  empty hint must account for the new tiles' toggles — update `hasInfoRow` logic).
- Verify: toggles show/hide tiles; shortcuts actually run; note survives relaunch.

## 5. Wrap-up

- Update README feature list (permission approval, onboarding, new widgets, hotkey).
- Update `agent-watch-feature` / `code-quality-findings` memory notes if behavior
  changed further.
- Run the full suite + a manual smoke of the expanded surface, then commit the
  remaining chunks and consider a `/code-review` pass over the branch diff.

## Build & test

```
xcodegen generate   # picks up new files under Notch/ automatically
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project Notch.xcodeproj -scheme Notch -configuration Debug \
  -derivedDataPath <scratch>/DerivedData CODE_SIGNING_ALLOWED=NO build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project Notch.xcodeproj -scheme NotchTests -derivedDataPath <scratch>/DerivedData \
  -destination 'platform=macOS,arch=arm64' CODE_SIGNING_ALLOWED=NO test
```

Note: a tested source file gaining a new dependency needs that file added to the
`NotchTests` sources list in `project.yml`. Run the app via
`open <DerivedData>/.../Notch.app`, not the bare binary (TCC crash otherwise).
