# Starboard — Battle Plan

> **Status (2026-08-21): Phases 1–7 implemented.** All phases below are built
> and unit-tested; `docs/SMOKE.md` holds the manual checklist. Two deliberate
> deviations from the original spec:
> - **Stages trigger is a leader key** (tap Caps Lock — consumed so the lock
>   never toggles — or a bare Right Shift tap, then letter/`=`/`-` within 3 s)
>   instead of a held chord: Caps Lock's down/up semantics are ambiguous at the
>   event-tap level, and the leader survives every remap.
> - **The rcmd+Tab window cycler reuses the vertical search overlay** (rcmd's
>   own window-list presentation) rather than a horizontal card strip — one
>   polished component instead of two half-polished ones.

A native macOS app switcher driven by the **Right Command** key, replicating the full feature set of rcmd (lowtechguys.com/rcmd) with Raycast-inspired visuals and Apple-grade polish. Personal use, no licensing/paywall — but built to product quality.

This document is the implementation spec. The repo already contains a compiling scaffold (menu bar app, event-tap stub, module folders); your job is to fill it in phase by phase. Do not skip the acceptance criteria at the end of each phase.

---

## 1. Product definition

### What the app does

Hold **Right ⌘ (rcmd)** and press a letter → the app whose name starts with that letter is focused. If it's already focused, it hides. If it's not running, it launches. The Left Command key is untouched and keeps working for normal shortcuts.

Full feature list (all of these ship eventually; phases below order them):

1. **Dynamic letter assignment** — running apps automatically get letters from their names; zero config out of the box.
2. **Custom assignments** — hold rcmd + Right ⌥ (ralt) + letter to pin the currently focused app to that letter, persisted.
3. **Same-letter cycling** — while holding rcmd, press the letter (or Tab) repeatedly to cycle apps sharing that letter.
4. **Fuzzy search overlay** — hold rcmd and type more than a trigger threshold, an overlay appears; fuzzy-search apps and windows; release rcmd to focus the selection. Double-tap-and-hold rcmd searches open windows only. While the overlay shows: ⌘W closes, ⌘Q quits, ⌘H hides the hovered/selected item.
5. **Cmd-Tab replacement** — rcmd+Tab cycles between windows (skipping minimized windows and other Spaces); typing while cycling switches to fuzzy search. rcmd+` cycles same-app windows across Spaces.
6. **Spaces navigation** — rcmd+1…9 jumps to that Space with no animation; ralt+1…9 moves the focused window to that Space; rcmd+[ / ] jumps to adjacent Spaces.
7. **Stages (workspace snapshots)** — a trigger key (default: Caps Lock, customizable) plus: `=` saves the visible apps as a Stage, a letter restores/activates a saved Stage (launching apps, opening configured files/folders/URLs, hiding non-Stage windows), `-` closes only the Stage's windows.
8. **Window jumping** — Right ⌥ + letter focuses a specific window of an assigned app.
9. **Mouse follows focused app** — optional: warp the pointer to the focused window's center on switch.
10. **On-screen key hints** — optional HUD showing which letters map to which apps while rcmd is held.

### Non-goals

- No licensing, trials, or payment. Everything unlocked.
- No Mac App Store build (the event-tap architecture is unsandboxable). Direct/local builds only.
- No companion on-screen keyboard (rcmd's "Keylume") — out of scope.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│ StarboardApp (SwiftUI @main, MenuBarExtra, LSUIElement)
│  └─ AppDelegate: lifecycle, permission gate, tap start
├─────────────────────────────────────────────────────┤
│ Core/EventTap    CGEventTap; owns ALL global key state
│   EventTap.swift        create/enable/re-enable tap
│   ModifierTracker.swift rcmd/ralt/capslock held-state
│   KeyRouter.swift       routes keys → intents while modifiers held
├─────────────────────────────────────────────────────┤
│ Core/Apps        what's running, what letter it owns
│   AppRegistry.swift     NSWorkspace observation
│   LetterAssigner.swift  dynamic + custom assignment engine
├─────────────────────────────────────────────────────┤
│ Core/Switching   focus / hide / launch / cycle
│ Core/Windows     AX + CGWindowList enumeration & focus
│ Core/Spaces      Space switching + window moving
│ Core/Stages      snapshot save/restore
│ Core/Search      fuzzy matcher (pure, testable)
├─────────────────────────────────────────────────────┤
│ UI/HUD           nonactivating NSPanel overlays (search, hints)
│ UI/Settings      SwiftUI settings window (Raycast-styled)
│ UI/Onboarding    permission flow
│ DesignSystem     tokens: colors, type, spacing, motion
│ Support          Permissions, Settings store, LoginItem
└─────────────────────────────────────────────────────┘
```

Principles:

- **One event tap, one state machine.** All global keyboard behavior flows through `KeyRouter`. Features register intents; nothing else creates taps or monitors.
- **Pure core, thin shell.** `LetterAssigner`, the fuzzy matcher, and Stage diffing are pure functions over value types — unit-testable without AX or a running app.
- **Main-actor UI, background enumeration.** Window enumeration (AX calls can block) happens off the main thread; results are published to the UI via `@Observable` stores.
- **YAGNI on dependencies.** Zero third-party packages. UserDefaults + Codable for persistence, hand-rolled fuzzy matcher, SMAppService for login item.

---

## 3. Critical technical knowledge (read before coding)

### 3.1 Event tap

- Create with `CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: keyDown | keyUp | flagsChanged, …)`. `.defaultTap` (not listen-only) so events can be **consumed** — return `nil` from the callback to swallow a keystroke.
- Requires Accessibility permission (`AXIsProcessTrustedWithOptions`). Gate app startup on it (Onboarding phase 1).
- Handle `kCGEventTapDisabledByTimeout` / `…ByUserInput` inside the callback by re-enabling the tap (`CGEvent.tapEnable`). Log it; never silently die.
- Keep the callback allocation-free and fast; it runs on every keystroke system-wide. Do dictionary lookups on prebuilt state, dispatch real work async to the main queue, and return immediately.

### 3.2 Modifier key identification

`flagsChanged` events tell you a modifier changed, and the event's `keyCode` field tells you *which physical key*:

| Key | keyCode |
|---|---|
| Left Command | 55 (0x37) |
| **Right Command** | **54 (0x36)** |
| Left Option | 58 (0x3A) |
| **Right Option** | **61 (0x3D)** |
| Caps Lock | 57 (0x39) |

Track held-state in `ModifierTracker` from flagsChanged keyDown/keyUp semantics (modifier down = flag bit present after the event; up = absent). Right-vs-left must come from keyCode, not from `CGEventFlags` (the generic `.maskCommand` bit is set for both sides; the device-side bits `NX_DEVICERCMDKEYMASK` = 0x10 in `event.flags.rawValue` also work as a cross-check).

Caps Lock as a Stages trigger: consume its flagsChanged event so the lock state doesn't actually toggle, and treat it as a plain modifier while configured. Offer alternatives (rshift, fn) in settings for users who remapped Caps Lock.

### 3.3 While rcmd is held

- Consume every `keyDown`/`keyUp` for keys Starboard handles (letters, digits, Tab, brackets, backtick, Escape) so they never reach the frontmost app.
- Do **not** consume anything when rcmd is not held — pass through untouched, always. A bug here bricks the user's keyboard; write this defensively and test first.
- On rcmd release, commit the pending action (e.g. focus the selected search result).
- Double-tap detection: two rcmd downs within 300 ms where the first press had no other key pressed.

### 3.4 App activation & letters

- Registry: `NSWorkspace.shared.runningApplications` filtered to `activationPolicy == .regular`; observe launches/terminations via KVO on `runningApplications` and `didActivateApplicationNotification` for MRU ordering.
- Letter for an app: first alphanumeric character of `localizedName`, lowercased, diacritics folded (`"Übersicht"` → `u`). Conflicts (Safari/Slack/Spotify on `s`): custom assignment wins, then frontmost/MRU, then the rest form the cycle order for repeated presses.
- Assignment stability: once a running app has a letter, don't reshuffle it while it stays running (jarring). Recompute only on launch/quit or custom-assignment change.
- Focus: `NSRunningApplication.activate()`. Hide: `.hide()`. Launch when not running: resolve via `NSWorkspace.shared.urlForApplication(withBundleIdentifier:)` — custom assignments store bundle IDs so pinned apps are launchable when closed; dynamic-only letters can also match installed-but-not-running apps found via Spotlight metadata query of `/Applications` (build this index lazily, cache it).
- "Press again to hide" is a toggleable setting (default on).

### 3.5 Windows

- Enumeration with titles: `CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements])`. Reading `kCGWindowName` of *other apps* requires **Screen Recording** permission (`CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`). Degrade gracefully without it: show app name + "Window N".
- Focusing a specific window: get the app's `AXUIElement` (`AXUIElementCreateApplication(pid)`), list `kAXWindowsAttribute`, match by `_AXUIElementGetWindow` window ID (private but stable; fallback: match on title + frame), then `AXUIElementPerformAction(kAXRaiseAction)` + set `kAXMainAttribute` + activate the app.
- Minimized detection: `kAXMinimizedAttribute`. Cmd-Tab replacement filters these and windows on other Spaces.

### 3.6 Spaces (the risky module)

There is no public API. Two strategies; implement both behind a setting, default to A:

- **Strategy A (robust): synthetic shortcuts.** macOS has hidden Mission Control shortcuts "Switch to Desktop N" (ctrl+1…9) that appear in System Settings once Spaces exist. Onboarding checks/enables guidance; Starboard posts the synthetic ctrl+digit `CGEvent`. "No animation" trick: not possible with this strategy — accept the animation.
- **Strategy B (rcmd-style): private CGS APIs.** `CGSMainConnectionID`, `CGSCopyManagedDisplaySpaces` (enumerate spaces per display), `CGSShowSpaces`/`CGSHideSpaces` + `CGSManagedDisplaySetCurrentSpace` for animation-free switching, `CGSMoveWindowsToManagedSpace` for ralt+1…9 window moves. Declare the C symbols in a `CGSPrivate.h` bridging header. These break across macOS majors — isolate behind a `SpaceSwitching` protocol, feature-detect at runtime (dlsym), and fall back to Strategy A if a symbol is missing.
- Adjacent-space jumps (rcmd+[ / ]) work in both strategies (ctrl+arrow synthetic events for A).
- Menu bar can display the current Space number when Strategy B is active (poll on space-change notification `NSWorkspace.activeSpaceDidChangeNotification`).

### 3.7 Persistence

Single `SettingsStore` (`@Observable`), Codable structs in UserDefaults under namespaced keys. Stages are a Codable array (name, trigger letter, app bundle IDs, per-app documents/URLs to open). Export/import as JSON via the settings window (nice-to-have, phase 7).

---

## 4. Design system — "Raycast-inspired, Apple-finished"

All tokens live in `DesignSystem/Theme.swift`. No hardcoded colors/fonts/durations anywhere else.

**Surfaces.** Overlays are `NSVisualEffectView` (`.hudWindow` material) with a near-opaque dark tint overlay `black.opacity(0.72)` (Raycast's window look); 16 pt corner radius on panels, 10 pt on rows; 1 px inner stroke `white.opacity(0.08)`; shadow radius 40, y 16, `black.opacity(0.35)`. Settings window: solid `#1E1F22` dark / `#F5F5F7` light (follow system appearance, dark-first in all mock decisions).

**Type.** System font (SF Pro) only. Rows 13 pt regular, titles 15 pt semibold, captions 11 pt medium at 60 % opacity. Shortcut keys render as **key tags**: 12 pt medium secondary text in a 28 pt rounded square, 8 pt radius, `white.opacity(0.08)` fill (Raycast list accessories).

**Color.** One accent: `#FF7A59` (coral — distinct from Raycast's red, warm against the dark surface). Semantic tokens: `accent`, `surface`, `surfaceRaised`, `textPrimary/secondary/tertiary`, `separator`, `destructive` (`#FF5F57`). Selection state: a quiet `white.opacity(0.08)` raised row, no accent wash and no bar (Raycast list selection); the accent is reserved for the caret and confirmations.

**Layout.** 8 pt grid. Search overlay: 760 × ~454 pt (64 pt header, eight 40 pt rows, 52 pt footer), centered horizontally, top at 28 % of screen height. Rows carry a 24 pt app icon, 15 pt title with the subtitle inline in secondary, and the letter tag trailing. Hint HUD: bottom-center pill grid of letter→icon pairs.

**Motion.** 140 ms ease-out for all state changes; overlay entrance: opacity 0→1 + scale 0.98→1, 160 ms; exit 100 ms fade only. No springs, no bounces. Cycling selection moves instantly (0 ms) — latency is the feature.

**Feel checklist** (apply everywhere): keyboard-first (every settings control reachable by Tab), no layout jumps when content changes, icons via `NSWorkspace.shared.icon(forFile:)` at retina sizes, respect Reduce Motion (drop scale animation), respect Increase Contrast (bump separator/text opacities).

---

## 5. Phases

Work strictly in order; each phase ends with its acceptance criteria demonstrably true and committed.

### Phase 1 — Skeleton that switches (core loop)
- Wire `EventTap` + `ModifierTracker` + `KeyRouter` for real (scaffold has stubs).
- `AppRegistry` + `LetterAssigner` with dynamic assignments; MRU tracking.
- rcmd+letter: focus / toggle-hide / launch-if-installed. Same-letter repeat cycling.
- Onboarding window: Accessibility permission request with live re-check, then start tap.
- Menu bar item: enable/disable toggle, settings (stub), quit.
- **Accept:** with Safari, Slack, Spotify running — rcmd+S focuses the best S match, Tab while holding cycles the three (stable per-hold order), rcmd+S on a focused S app hides it (or cycles when hide-on-repeat is off), rcmd+M launches Mail from cold. Left ⌘ shortcuts unaffected. Keyboard behaves 100 % normally when rcmd not held.

### Phase 2 — Custom assignments + persistence
- rcmd+ralt+letter pins the frontmost app to that letter (works mid-hold; shows a confirmation toast HUD).
- Assignments persisted by bundle ID; custom beats dynamic; conflict re-flow for the displaced dynamic app.
- Settings window v1 (Raycast-styled): assignment table (letter, app, dynamic/custom badge, clear button), general toggles (launch-if-closed, hide-on-repeat, launch-at-login via `SMAppService`).
- **Accept:** pin Slack to K, quit + relaunch Starboard, rcmd+K still focuses Slack even when Slack was closed (launches it).

### Phase 3 — Fuzzy search overlay
- Pure fuzzy matcher in `Core/Search` (subsequence scoring: consecutive-run bonus, word-boundary bonus, start-of-string bonus) + unit tests.
- Nonactivating `NSPanel` overlay (never steals focus — input arrives via the event tap, not the panel). Typing ≥1 non-assigned key or holding rcmd past 250 ms with typed input shows it; results list apps (icon, name, letter chip). Release rcmd → focus top/selected hit; Escape cancels; arrows/Tab move selection.
- Double-tap-and-hold rcmd → windows-only mode (needs Phase 4 enumeration; ship apps-only first, flip on later).
- ⌘W/⌘Q/⌘H act on selection while overlay is open.
- **Accept:** rcmd, type "xco" → Xcode top hit; release → focused. Overlay never takes key focus from the frontmost app (verify: a text field caret in Safari keeps blinking).

### Phase 4 — Windows: enumeration, Cmd-Tab replacement, window jumping
- `Core/Windows`: enumeration (CGWindowList + AX merge), Screen Recording soft-prompt in onboarding (skippable; titles degrade), focus-specific-window machinery.
- rcmd+Tab: window cycler HUD (horizontal strip of window cards: app icon + title), filters minimized/other-Space windows; typing switches to fuzzy window search; release focuses.
- rcmd+` cycles the frontmost app's windows.
- ralt+letter: window-jump — focus cycles that app's windows directly.
- Search overlay windows-mode goes live.
- **Accept:** two Safari windows + minimized Notes: rcmd+Tab shows both Safari windows, not Notes; selecting the background one raises exactly that window.

### Phase 5 — Spaces
- `SpaceSwitching` protocol; Strategy A (synthetic ctrl+digit / ctrl+arrows) + Strategy B (CGS private, runtime-feature-detected, animation-free) per §3.6. Setting to choose; auto-fallback A.
- rcmd+1…9 jump, rcmd+[ ] adjacent, ralt+1…9 move focused window (Strategy B only; hide the binding when unavailable).
- Optional menu-bar Space number.
- **Accept:** on a 3-Space setup, rcmd+3 lands on Space 3; with Strategy B, no swipe animation; on symbol-missing macOS the app silently uses Strategy A and nothing crashes.

### Phase 6 — Stages
- Trigger key config (Caps Lock default, consumed per §3.2; alternatives offered).
- trigger+`=`: snapshot visible apps of current Space into a named Stage (sheet to name it + assign letter). trigger+letter: restore — launch missing apps, open configured files/folders/URLs (editable per-Stage in settings), hide non-Stage apps; second press = activate (re-hide intruders). trigger+`-`: close the Stage's windows only (AX close button per window, never `terminate`).
- Stage editor in settings: app list, per-app open-items, reorder, delete.
- **Accept:** save a "writing" Stage (Notes + Safari with a URL); switch to other apps; trigger+W restores both, opens the URL, hides everything else. Caps Lock LED/state never toggles.

### Phase 7 — Polish pass (the "Apple-like" phase)
- Key-hint HUD (hold rcmd 400 ms with no keypress → letter grid; setting to disable).
- Mouse-follows-focus option (warp pointer via `CGWarpMouseCursorPosition` to focused window center).
- Full settings audit against §4: keyboard navigation, dark/light, Reduce Motion/Contrast, empty states, alignment sweep at 2× zoom.
- Onboarding final: 3-step welcome (what it does → Accessibility → optional Screen Recording), replay-able from settings.
- Sounds: none. Haptics: none. (Polish is restraint.)
- App icon: coral compass/starboard motif, macOS 26 squircle template, test at 16 px.
- JSON settings export/import; `About` window with version.
- **Accept:** a new user can go from first launch to switching apps in under 60 seconds without reading docs; every screen passes the §4 feel checklist.

---

## 6. Testing

- Unit tests (XCTest target, already in project.yml): `LetterAssigner` conflict/stability matrix, fuzzy scorer ranking table, Stage snapshot/diff round-trip, settings Codable migration.
- Manual smoke script in `docs/SMOKE.md` (write it in Phase 1, grow per phase): the acceptance criteria above as a checklist.
- The event tap itself can't be CI-tested — keep `KeyRouter` pure (input: key event + modifier state → output: `Intent` enum) so routing *is* testable; only the thin tap callback is untested.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Private CGS APIs break on a macOS update | Protocol seam + dlsym feature-detect + Strategy A fallback (§3.6) |
| Event-tap bug swallows normal typing | Never consume when rcmd/ralt/trigger not held; kill-switch: menu bar toggle + auto-disable tap on 3 consecutive callback crashes |
| Tap silently disabled by timeout | Re-enable in callback + watchdog timer re-checking `CGEvent.tapIsEnabled` every 5 s |
| AX calls hang on unresponsive apps | All AX enumeration off-main with per-app 250 ms timeout (`AXUIElementSetMessagingTimeout`) |
| Caps Lock consumption fights user remaps (e.g. hyper key) | Detect Karabiner/hidutil remapping is out of scope; just make the trigger key configurable and default-off if Caps Lock events look remapped |

## 8. Repo map (scaffold already present)

```
starboard/
  BATTLEPLAN.md            ← this file
  README.md
  project.yml              ← XcodeGen spec (app + unit test targets, entitlements, Info.plist)
  Makefile                 ← make gen / build / run / test
  Starboard/
    StarboardApp.swift     @main MenuBarExtra + AppDelegate
    Core/EventTap/         EventTap.swift, ModifierTracker.swift, KeyRouter.swift, Keycodes.swift
    Core/Apps/             AppRegistry.swift, LetterAssigner.swift
    Core/Switching/        AppSwitcher.swift
    Core/Windows/          (Phase 4)
    Core/Spaces/           (Phase 5)
    Core/Stages/           (Phase 6)
    Core/Search/           FuzzyMatcher.swift (Phase 3)
    UI/Settings/           SettingsView.swift
    UI/HUD/                (Phase 3+)
    UI/Onboarding/         (Phase 1)
    DesignSystem/          Theme.swift
    Support/               Permissions.swift, SettingsStore.swift
  StarboardTests/          LetterAssignerTests.swift (seed)
```

Build loop: `make gen` (runs `xcodegen`), `make build`, `make run`. Requires `brew install xcodegen`. Ad-hoc codesigning is configured; Accessibility permission must be re-granted after each rebuild unless you sign with a stable identity — for daily development, set `CODE_SIGN_IDENTITY` to your Apple Development cert in `project.yml` to keep TCC grants sticky.
