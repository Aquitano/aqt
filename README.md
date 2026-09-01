# Notch

A native macOS notch / Dynamic-Island app for **macOS 26 (Tahoe)**: Now Playing, live
activities + HUDs, a file tray with AirDrop, coding-agent watching (Claude Code, Codex &
friends, including in-notch approval of permission prompts), and widgets (battery, calendar,
weather, Bluetooth battery, focus, clock, Shortcuts runner, quick note). First launch opens
a welcome tour; an opt-in global hotkey (⌃⌥N) toggles the notch. Built per
[`docs/archive/BUILD_PLAN.md`](docs/archive/BUILD_PLAN.md).

Agent app (no Dock icon), Developer-ID signed, **not sandboxed**. Direct distribution only.

## Requirements

- macOS 26 (Tahoe) — the deployment target; no back-compat shims.
- Xcode 26+ with the macOS 26 SDK.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`.

## Build

```sh
cd notch
./run.sh                    # regenerate the Xcode project and build Debug
./run.sh --run              # build, stop an older Notch instance, and launch
```

The app is written to `DerivedData/Build/Products/Debug/Notch.app`. The script selects the
full Xcode toolchain at `/Applications/Xcode.app/Contents/Developer`, since the system-wide
developer directory may otherwise point at Command Line Tools. Run `./run.sh --help` for its
options.

To work in Xcode instead, run `xcodegen generate`, open `Notch.xcodeproj`, and choose the
Notch scheme. Quit any already-running Notch instance before using Xcode Run; macOS prohibits
multiple instances of this app.

The sole Swift package dependency is the audited `mediaremote-adapter`, pinned to an exact
revision in `project.yml`. It is embedded as a runtime bridge and deliberately not linked into
the app binary. All other features use system frameworks.

### Signing

`project.yml` sets `CODE_SIGN_STYLE: Manual` / `CODE_SIGN_IDENTITY: "Developer ID Application"`
and leaves `DEVELOPMENT_TEAM` empty. For local runs either:

- set your team + identity in `project.yml` (`settings.base.DEVELOPMENT_TEAM`) and regenerate, or
- in Xcode, select the target → Signing & Capabilities → pick your team / "Sign to Run Locally".

Use a **stable** signing identity during development: TCC grants (Input Monitoring,
Calendars, Automation) are keyed to the identity, so ad-hoc re-signing makes macOS forget them.

## Releases and updates

Updates ship through [Sparkle](https://sparkle-project.org). Local builds leave `SUFeedURL`
empty, so they never check; `.github/workflows/release.yml` builds, signs, notarizes and
publishes a tagged release together with a signed `appcast.xml` served from the latest
release's assets. One-time setup:

1. `generate_keys` (from Sparkle's `bin/`) once; keep the private key out of the repo.
2. Add the secrets listed at the top of the workflow to the GitHub repository.
3. Tag a commit `vX.Y.Z` and push the tag.

## Permissions

The app requests these lazily; deny-able without crashing:

| Feature | Permission | Prompt |
|---|---|---|
| Volume/brightness HUD | Input Monitoring | first media-key press (System Settings → Privacy → Input Monitoring) |
| Media (Music/Spotify fallback) | Automation (Apple Events) | first control of Music/Spotify |
| Live three-band audio visualizer | Screen & System Audio Recording | enabling the visualizer in Settings |
| Calendar widget | Calendars (full access) | "Enable Calendar" in the widget |
| Weather | Location (optional) | "Enable Location" in the widget |
| AirPods/BT battery | — (system_profiler) | none for battery; Bluetooth prompt only for future live AirPods |
| Focus badge | Focus status | on first launch |
| Battery, tray, AirDrop | none | — |

## Now Playing: the two paths

System-wide Now Playing is included and enabled by default. It covers Music, Spotify,
browsers, Podcasts, and any other app publishing through macOS MediaRemote. The framework is
built from [ejbills/mediaremote-adapter](https://github.com/ejbills/mediaremote-adapter) at
the exact revision recorded in `project.yml`, embedded and signed, but deliberately **not
linked** into Notch. `/usr/bin/perl` loads it at runtime so the request is hosted by a platform
binary.

At launch, Notch runs the adapter's one-shot `get` command off-main. The bridge must exit
successfully and emit either `NIL` or a valid protocol frame before Notch switches away from
the always-available Music/Spotify AppleScript controller. A missing artifact, protocol drift,
timeout, or stream crash automatically restores that fallback.

Compact Now Playing and its three-band live audio visualizer have independent toggles in
Settings. The visualizer uses ScreenCaptureKit audio buffers to measure bass, mids, and treble;
it does not capture video, excludes Notch's own process audio, publishes at no more than 30 fps,
and stops completely whenever playback pauses, the compact pill disappears, the window is
occluded, or the feature is disabled.

The build runs `Scripts/verify_media_adapter.sh`, which checks the bundled launcher's pinned
checksum, framework ABI, placement, signature when signing is enabled, and—critically—that
neither app binary links the framework. No runtime download, quarantine bypass, or manual
artifact installation is used. See [`docs/MEDIA_ADAPTER.md`](docs/MEDIA_ADAPTER.md) for the
pin, validation matrix, diagnostics, and rollback procedure.

## Architecture

Single background agent process; one SwiftUI tree per display hosted in an AppKit
overlay panel. Sources are grouped by feature, not by layer.

```
App/            NotchApp (@main), AppDelegate (status item, lifecycle), AppEnvironment (DI root)
Shell/          The notch itself
  Window/         NotchPanel (borderless non-activating), NotchWindowController, ScreenGeometry,
                  DisplayInventory + display policies, HitRegion
  State/          NotchCoordinator (one NotchState per display), NotchState (presentation machine),
                  Animations (the asymmetric springs)
  Views/          NotchRootView + NotchShape, Compact/Expanded, tab strips, Theme
  Components/     GlassButton, MarqueeText, PixelIcon, ...
Features/       One folder per feature: model, manager, services and views together
  Activities/     ActivityManager (generic priority queue), Activity, ActivityPresenter
  Agents/         AgentManager, providers, socket server, transcript/status parsers, hook client
  HUD/            HUDManager, CoreAudio, DisplayServices brightness, the media-key event tap
  Media/          MediaManager + controllers, audio visualizer
  Tray/           TrayManager, ingestion pipeline, Quick Look, screenshot candidates, views
  Timer/          Pomodoro timer
  Widgets/        Battery, Calendar, Weather, Bluetooth, Focus, Shortcuts, Note, Clock
  Settings/       Preferences document, Settings (live), SettingsView
  Onboarding/
Platform/       Shared adapters and utilities: Persistence, Diagnostics, ImageCache, HotKey,
                LoginItem, Haptics, Keychain, Logging, watch()
```

**Iconography:** custom controls and status glyphs use one crisp 7×7 pixel system,
matching the agent working indicator. Semantic color remains feature-driven; album artwork
and file thumbnails remain native content rather than being stylized.

**Concurrency:** managers are `@MainActor @Observable` classes; heavy work (image decode,
`system_profiler`, perl I/O, system-audio analysis, file copies) runs off-main and hops back
only to publish.

**Almost no timers.** Nearly everything is push-based (Combine, NotificationCenter,
DistributedNotificationCenter, IOKit/CoreAudio run-loop sources, async sequences). Activity
TTLs are one-shot `Task.sleep`s. The two exceptions are slow refresh cadences with no push
source: weather (15 min) and the calendar countdown (5 min). The panel is `orderOut` when
fully hidden and pauses work on occlusion.

## Known constraints

- System-wide Now Playing uses a private MediaRemote bridge that Apple can change in a macOS
  update; the runtime self-test automatically falls back to Music/Spotify if that happens.
- No fullscreen / lock-screen presence (decided): `collectionBehavior` only, no CGS/SkyLight.
- Third-party notification mirroring is out of scope; Quick Peeks are self-generated
  (battery / device connect / focus / timer).
