# Notch

A native macOS notch / Dynamic-Island app for **macOS 26 (Tahoe)**: Now Playing, live
activities + HUDs, a file tray with AirDrop, and widgets (battery, calendar, weather,
Bluetooth battery, focus). Built per [`BUILD_PLAN.md`](BUILD_PLAN.md).

Agent app (no Dock icon), Developer-ID signed, **not sandboxed**. Direct distribution only.

## Requirements

- macOS 26 (Tahoe) — the deployment target; no back-compat shims.
- Xcode 26+ with the macOS 26 SDK.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`.

## Build

```sh
cd notch
xcodegen generate          # produces Notch.xcodeproj from project.yml
open Notch.xcodeproj        # then run, or:
xcodebuild -project Notch.xcodeproj -scheme Notch -configuration Debug build
```

There are **no external Swift package dependencies** — the app uses system frameworks only,
so it builds without any package resolution step. (`swift-collections` from the plan was
dropped in favour of a plain array; the `mediaremote-adapter` bridge is an opt-in, see below.)

### Signing

`project.yml` sets `CODE_SIGN_STYLE: Manual` / `CODE_SIGN_IDENTITY: "Developer ID Application"`
and leaves `DEVELOPMENT_TEAM` empty. For local runs either:

- set your team + identity in `project.yml` (`settings.base.DEVELOPMENT_TEAM`) and regenerate, or
- in Xcode, select the target → Signing & Capabilities → pick your team / "Sign to Run Locally".

Use a **stable** signing identity during development: TCC grants (Input Monitoring,
Calendars, Automation) are keyed to the identity, so ad-hoc re-signing makes macOS forget them.

## Permissions

The app requests these lazily; deny-able without crashing:

| Feature | Permission | Prompt |
|---|---|---|
| Volume/brightness HUD | Input Monitoring | first media-key press (System Settings → Privacy → Input Monitoring) |
| Media (Music/Spotify fallback) | Automation (Apple Events) | first control of Music/Spotify |
| Calendar widget | Calendars (full access) | "Enable Calendar" in the widget |
| Weather | Location (optional) | on first launch |
| AirPods/BT battery | — (system_profiler) | none for battery; Bluetooth prompt only for future live AirPods |
| Focus badge | Focus status | on first launch |
| Battery, tray, AirDrop | none | — |

## Now Playing: the two paths

By default the app reads Now Playing from **Music and Spotify via AppleScript** (push-driven by
each app's distributed notifications). This works out of the box and needs only Automation
permission.

For **system-wide** Now Playing (any app: browsers, podcasts, etc.), enable the
`mediaremote-adapter` perl bridge. Unentitled apps can't read `MRMediaRemoteGetNowPlayingInfo`
since macOS 15.4, so the app shells out to `/usr/bin/perl` (a platform binary that passes the
daemon's entitlement check) running the adapter script.

`AdapterMediaController` drives it directly with `Process` (no SPM dependency). It activates at
runtime **only** when both artifacts are bundled and its `test` command exits 0; otherwise it
silently falls back to AppleScript.

### Enabling system-wide Now Playing

1. Get a known-good `mediaremote-adapter.pl` and a prebuilt `MediaRemoteAdapter.framework`
   from [ejbills/mediaremote-adapter](https://github.com/ejbills/mediaremote-adapter) (pin a
   known-good commit — see the risk register in `BUILD_PLAN.md`).
2. Add `mediaremote-adapter.pl` to the app target as a **bundle resource**.
3. Add `MediaRemoteAdapter.framework` under **Contents/Frameworks**, code-signed, and
   **NOT linked** (do not add it to "Link Binary With Libraries" — hardened runtime / library
   validation will reject a linked, non-platform framework). In Xcode: "Embed Without Signing"
   is wrong here; embed it and ensure it's signed but not in the link phase.
4. Keep `enableMediaAdapter` on in Settings (default). Relaunch.

If the control sub-commands (`send`/`seek`/`shuffle`/`repeat`) don't match your pinned fork,
adjust the argument strings in `Notch/Managers/Media/AdapterMediaController.swift` — **reads**
go through the JSON `stream` which this app parses itself, so they're independent of those names.

## Architecture

Single background agent process; one SwiftUI tree hosted in an AppKit overlay panel.

```
App/            NotchApp (@main), AppDelegate (status item, lifecycle), AppEnvironment (DI root)
Window/         NotchPanel (borderless non-activating), NotchWindowController, ScreenGeometry
State/          NotchState (presentation machine), Animations (the asymmetric springs)
Model/          Activity, MediaModels, SystemModels, DropItem
Managers/       MediaManager (+ Media/ controllers), HUDManager, ActivityManager, TrayManager,
                Widgets/ (Battery, Calendar, Weather, BluetoothBattery, Focus)
Services/       ImageCache (ImageIO downsample), Persistence, AudioHardware (CoreAudio),
                Brightness (DisplayServices dlopen), SystemDefinedTap (listen-only event tap)
Views/          NotchRootView + NotchShape, Compact/Expanded, Media/, HUD/, Activity/, Tray/,
                Widgets/, Components/ (GlassButton, MarqueeText)
Settings/       Settings (UserDefaults model), SettingsView
```

**Concurrency:** managers are `@MainActor ObservableObject`s; heavy work (image decode,
`system_profiler`, perl I/O, file copies) runs off-main and hops back only to publish.

**No timers.** Everything is push-based (Combine, NotificationCenter, DistributedNotificationCenter,
IOKit/CoreAudio run-loop sources, async sequences). Activity TTLs are one-shot `Task.sleep`s.
The panel is `orderOut` when fully hidden and pauses work on occlusion.

## Known constraints

- Built on Linux without an Xcode toolchain, so the source is authored without compiler
  feedback. Expect to fix a few SDK-specific signatures on first build — the private
  `DisplayServices` brightness symbol and the CoreAudio `VirtualMainVolume` selector are the
  most likely to need a tweak; both are isolated to one file each.
- No fullscreen / lock-screen presence (decided): `collectionBehavior` only, no CGS/SkyLight.
- Third-party notification mirroring is out of scope; Quick Peeks are self-generated
  (battery / device connect / focus / timer).
