# Agent Memory & Project Context

## 1. Project Patterns & Conventions

- Native macOS 26 app generated with XcodeGen from `project.yml`; the system-wide media bridge is the sole external package and is pinned to an exact revision, embedded without linking.
- Managers are `@MainActor` observable objects. File/process/network work should use nonisolated helpers or dedicated workers and return to the main actor only to publish state.
- Build with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` because the system-selected developer directory may point at Command Line Tools.
- Keep the main app, `notch-hook`, and hostless logic tests independently buildable.

## 2. Lessons Learned & Gotchas

- The checked-in Xcode project must be regenerated after adding source or asset files: `xcodegen generate`.
- macOS XCTest execution needs access to `testmanagerd`; restricted sandboxes can compile tests but cannot run them.
- The `NotchTests` target compiles production source files directly, so helper signatures and its explicit source list must stay synchronized.
- Agent integration mutates user-owned CLI configuration; writes must be coordinated and preserve concurrent edits.
- `MediaRemoteAdapter.framework` must be embedded + signed but never linked into Notch; `/usr/bin/perl` loads its executable and the `get` response gates activation.
- App semantic iconography uses `PixelIcon`: crisp 7×7 glyphs keyed by existing semantic symbol names. Keep SF Symbols out of custom notch surfaces; retain real artwork and file thumbnails as content.
- The compact live audio meter uses ScreenCaptureKit audio-only capture through `AudioVisualizerManager`; keep capture opt-in and active only while compact media is visible, playing, and unobscured. Analyze mono PCM off-main and publish no faster than 30 fps.
- `LSMultipleInstancesProhibited` makes Xcode Run fail immediately with `IDELaunchErrorDomain` code 20 when a prior Notch menu-bar process is still alive. Quit/terminate the existing Notch instance before launching under Xcode; the error is not necessarily a signing failure.
- The physical notch-sized `.compact` presentation is the persistent hover target even when it has no side content. Reserve `.hidden` for the explicit menu/hotkey toggle; hiding on an empty activity queue makes hover reopening impossible.
- Agent notification sounds use the synthesized 8-bit square-wave palette in `AgentSoundPlayer`; keep cues short, rate-limited, and generated in code, and normalize legacy macOS sound names when reading settings.
- Opening a separate app window from the expanded notch must call `NotchState.collapseImmediately()` before activating that window; hover-exit collapse has an intentional grace delay and is not a reliable dismissal mechanism for explicit navigation.
- Keep window hit-region snapshots sourced from the same aggregate layout properties as SwiftUI (`Settings.hasInfoRowWidgets`); duplicating individual widget flags makes newly added rows visible but click-through.
- The master agent-watch switch pauses providers and the Unix socket without uninstalling per-agent hooks. Stop/start must invalidate queued socket events and discard transient provider sessions so stale activity cannot return after resume.
- Multi-display presentation uses one local `NotchState` per `NotchPanelHost`, coordinated through the global state for programmatic commands. Only the active primary host may own HUD and shared rendering lifecycle work, so capture does not multiply with display count.

## 3. User Preferences

- Fix release blockers comprehensively, verify them, and commit the completed work.
- Prefer the retro pixel-art visual language from the agent activity animation across all icons and lightweight state motion.

## 4. Current Context / Scratchpad

- Turnkey system-wide Now Playing completed: pinned package, bundled launcher, build verifier, protocol decoding, automatic fallback, real `get`/`loop` + app lifecycle smoke tests, signed embedding, Debug/Release/analyze, and 90 tests pass. Live Music/Spotify/Safari/Podcasts control checks remain a manual pre-distribution matrix; signed update pipeline remains tracked externally.
- Retro icon pass completed: all custom notch surfaces and the menu-bar item use the shared 7×7 `PixelIcon` family; the macOS app-icon set now carries the same stepped notch and pixel-waveform identity. Debug, Release, and static analysis pass after regeneration.
- Compact media controls completed: independent persisted toggles for compact Now Playing and its real three-band audio visualizer, explicit Screen & System Audio Recording permission UI, no fake playback animation, and clean fallback to other compact activities. Debug/Release/analyze and 95 tests pass.
- Compact-media regression pass completed: disabling compact Now Playing preserves the base hover target, the home tab glyph is optically centered, and agent notifications use a selectable synthesized 8-bit palette. Debug, unsigned Release, static analysis, and 99 tests pass; signed Release still requires a local Developer ID identity/team.
- Release-readiness correctness fixes completed: all info-row widgets now expand the interactive hit region, and the master agent-watch switch immediately stops/restarts providers and its socket while preserving installed integrations. Debug, universal unsigned Release, and 100 tests pass.
- High-impact expansion is specified in `HIGH_IMPACT_FEATURE_PLAN.md`: external/all-display and virtual-notch coordination, structured risk-aware agent approvals, and a workflow-grade tray with rich items, collections, Quick Look, explicit move semantics, visible expiry, and opt-in screenshot candidates.
- All-displays coordination completed: Settings can create one compact host per selected screen, with exclusive expansion/key interaction, pointer-local drag routing, active-display HUD/render ownership, and safe topology migration. Debug, universal unsigned Release, static analysis, and 119 tests pass; the virtual-notch mode selector remains in the display track.
