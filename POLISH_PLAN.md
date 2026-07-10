# Polish Plan — status

Feature/UX round on `code-review-fixes-2026-07-02`, finished 2026-07-07. Everything below
is committed in per-feature chunks; build/test commands are at the bottom.

## Done

1. **Small fixes** — settings-window sizing, Home-tab empty state, timers doc claim.
2. **Error surfaces** — `AgentManager.integrationError` in Settings, weather
   failed-fetch Retry, media `adapterState` reason, `InstallerError: LocalizedError`.
3. **Agent-watch v2** — Esc-interrupt reads idle; in-notch PermissionRequest approval
   (blocking hook → socket reply, Approve/Deny in the row, opt-in
   `agentPermissionApproval`). 84 unit tests green.
4. **Onboarding** — `OnboardingView` + AppDelegate window on first launch
   (`hasCompletedOnboarding`), re-entry via Settings → "Show Welcome Tour"
   (`.showOnboarding` notification).
5. **Keyboard & a11y** — global hotkey ⌃⌥N (Carbon `RegisterEventHotKey`, opt-in,
   keyCode+modifiers stored for a future recorder); VoiceOver expand/collapse actions on
   the pill and expanded body; relative text styles in agent rows + widget tiles (pill/HUD
   deliberately fixed, noted in `NotchLayout`).
6. **Media adapter** — drop-in path `~/Library/Application Support/Notch/adapter/`
   checked before the bundle; Settings install offer (open folder + instructions) and
   Remove button; fork-sensitive sub-commands folded into one `Command` enum.
   *Deviation from plan:* upstream publishes **no prebuilt release**, so there is nothing
   to download + checksum; the guided folder flow replaced the auto-download.
7. **New widgets** — clock (status row, `TimelineView(.everyMinute)`, optional second
   zone), Shortcuts runner (pinned names, errors via activity peek), quick note
   (Persistence-backed; panel gained a text-editing key latch). All off by default;
   `Settings.hasInfoRowWidgets` drives grid + panel height.

## Manual interaction verification before distribution

Native startup smoke-tested from the generated `.app` on macOS 26.5.2 on 2026-07-10.
The permission- and hardware-dependent interaction matrix still needs a human pass:

- Launch flow: `defaults delete com.aquitano.notch hasCompletedOnboarding`, launch,
  complete tour, relaunch → no tour. (Launch via `open <DerivedData>/…/Notch.app`; the
  fresh build path will re-prompt Bluetooth TCC once.)
- Hotkey toggles with another app frontmost; VoiceOver (⌘F5) expand/collapse; text at
  larger accessibility sizes.
- Quick-note typing (key latch), shortcut run + failure peek, clock second zone.
- Adapter: drop artifacts into the folder (after `xattr -dr com.apple.quarantine`),
  relaunch → `adapterState == .active`; Remove reverts to scripting.

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
