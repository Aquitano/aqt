# Notch App — Build Plan

A native macOS notch/Dynamic-Island app, built for polish, low idle CPU, and small RAM.
This plan is the technical blueprint; it cites exact APIs and reference repos so you can
move fast. It assumes Swift fluency and goes deep on the AppKit/private-framework parts
you haven't done before.

## Locked decisions

| Decision | Choice |
|---|---|
| v1 scope | Media/Now Playing **+** HUDs/live activities **+** Tray/AirDrop **+** Widgets (all four) |
| Distribution | Personal use; Developer-ID signed + notarized DMG; **not** sandboxed; private APIs OK |
| Min target | **macOS 26 (Tahoe)** only — newest SwiftUI, Liquid Glass, no back-compat shims |
| Now Playing | `mediaremote-adapter` perl-bridge (system-wide) → AppleScript fallback (Music/Spotify) |
| Displays | Built-in panel only for v1 (real notch); external + virtual notch deferred |
| Window coverage | `collectionBehavior` only — **no** fullscreen/lock-screen presence; no CGS/SkyLight private APIs |
| Weather | **Open-Meteo** (no key, no account) — no WeatherKit (no paid Apple Developer account) |
| Native HUD | **Overlay only** — show our HUD alongside the system HUD; do not consume keys / touch the system |
| Experience | Swift-fluent, new to AppKit/notch — deep dives below on windowing, private frameworks, geometry |

Reference implementations to study/borrow (all ship the techniques below):
**DynamicNotchKit** (MrKai77) — cleanest window/shape/animation scaffold ·
**boring.notch** (TheBoredTeam) — media wiring, CGS spaces, shelf, sharing ·
**NotchDrop** (Lakr233) — tray + AirDrop ·
**AirBattery** (lihaoyun6) — AirPods battery parsing ·
**ejbills/mediaremote-adapter** — the Now Playing bridge (SPM).

---

## 1. Architecture

Single background agent process. No XPC services, no helper apps (except the bundled,
non-linked `MediaRemoteAdapter.framework` + `mediaremote-adapter.pl` that the media bridge
spawns via `/usr/bin/perl`).

```
NotchApp (LSUIElement / .accessory agent)
├─ AppDelegate (NSApplicationDelegateAdaptor)
│   ├─ owns NSStatusItem  (menu-bar affordance + settings entry)
│   └─ owns NotchWindowController
├─ NotchWindowController
│   ├─ NotchPanel : NSPanel        (borderless, clear, non-activating, above menu bar)
│   ├─ NSHostingView(rootView: NotchRootView)   ← the one SwiftUI tree
│   └─ ScreenGeometry              (notch frame, recomputed on display change)
├─ NotchState (ObservableObject)   ← single source of truth
│   ├─ presentation: .hidden | .compact | .expanded
│   ├─ activityQueue: [Activity]   (media, charging, connect, notification, timer…)
│   └─ activeTab / hover / settings
├─ Feature managers (each event-driven, no polling)
│   ├─ MediaManager      (mediaremote-adapter + AppleScript fallback)
│   ├─ HUDManager        (listen-only event tap → overlay)
│   ├─ ActivityManager   (live activities + Quick Peek notifications)
│   ├─ TrayManager       (file shelf + outbound drag + AirDrop)
│   └─ Widgets: BatteryManager, CalendarManager, WeatherManager,
│              BluetoothBatteryManager, FocusManager
└─ Services: ImageCache (ImageIO downsample), Persistence (UserDefaults/JSON)
```

**Concurrency model.** Managers are `@MainActor` `ObservableObject`s that own their
subscriptions; heavy work (image decode, `system_profiler`, file copies, perl I/O) runs on
background queues/`Task.detached` and hops back to main only to publish. Everything is
push-based (Combine publishers / `NotificationCenter` / async sequences). **Zero repeating
`Timer`s** — they are the #1 cause of phantom idle CPU in these apps.

**State → UI.** `NotchState.presentation` drives the morph. Activities are a priority queue;
the topmost renders in the compact notch, the rest are cyclable. One SwiftUI tree hosted in
the panel; AppKit only owns the window and the event tap.

---

## 2. Deep dive: the notch overlay window (AppKit)

This is the part with no SwiftUI equivalent. Build it first; everything renders inside it.

**The panel.** Subclass `NSPanel` (not `NSWindow`):

```swift
final class NotchPanel: NSPanel {
    init(contentRect: NSRect) {
        super.init(contentRect: contentRect,
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3) // above the menu bar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        isMovable = false
        isReleasedWhenClosed = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
    }
    // Passive overlay: don't steal focus. Flip to true only while presenting the AirDrop sheet.
    override var canBecomeKey: Bool { presentingShareSheet }
    override var canBecomeMain: Bool { false }
}
```

- Order it on screen with `orderFrontRegardless()` (not `makeKeyAndOrderFront`) so it
  surfaces without activating the app.
- `.nonactivatingPanel` is what keeps the frontmost app focused.
- `isReleasedWhenClosed = false` or you crash on reuse.

**Notch geometry.** Pick the built-in screen (`safeAreaInsets.top > 0`), then:

```swift
let inset = screen.safeAreaInsets            // .top == notch height
let notchHeight = inset.top
let notchWidth  = screen.frame.width
                - (screen.auxiliaryTopLeftArea?.width  ?? 0)
                - (screen.auxiliaryTopRightArea?.width ?? 0)
let notchFrame = NSRect(x: screen.frame.midX - notchWidth/2,
                        y: screen.frame.maxY - notchHeight,   // bottom-left origin
                        width: notchWidth, height: notchHeight)
```

`auxiliaryTopLeftArea/RightArea` are Optional and only present on notched screens — guard
them. Recompute on `NSApplication.didChangeScreenParametersNotification`. Don't assume
`NSScreen.screens[0]` is the built-in. For non-notch Macs, fall back to a floating pill
(out of scope for v1, but keep the geometry abstracted so you can add it).

**Hit-testing.** The panel spans a region around the notch but most of it must be
click-through. Make the window `ignoresMouseEvents` while `.hidden`, and only enable hit
testing on the actual content bounds when `.compact`/`.expanded`. Use SwiftUI `.onHover`
(or an `NSTrackingArea`) on the content view to trigger expand.

**Floating over fullscreen / lock screen — decided: not needed.**
`collectionBehavior` alone does *not* reliably keep the overlay above a true-fullscreen app
or on the lock screen, but you've decided neither is required. So **stop at
`collectionBehavior`** and skip the private CGS Spaces / SkyLight path entirely. This removes
the most fragile, point-release-breakable code from the project — the overlay shows on normal
Spaces and the desktop, hides under fullscreen apps and the lock screen, and that's fine.
(For reference, the bulletproof-everywhere approach would have been `CGSSpace` +
`CGSAddWindowsToSpaces` + `SLSRemoveWindowsFromSpaces` — explicitly out of scope.)

---

## 3. Deep dive: state machine + the "morph" (SwiftUI on Tahoe)

The Apple feel comes almost entirely from one detail: an **asymmetric spring** on a single
state enum, with the black "blob" shape and the content morphing together.

- **Shape.** A custom `Shape` (`NotchShape`) with animatable corner radii
  (`AnimatablePair`) that interpolates from the small notch rectangle to the big rounded
  panel. The blob is solid black (matches the bezel); material/glass is only for the
  expanded body.
- **Content morph.** Share a `@Namespace` and use `matchedGeometryEffect(id:in:)` so the
  album thumbnail glides/scales from the compact dot into the expanded player. Inject the
  namespace through the SwiftUI environment into the hosting view (don't create a fresh
  `@Namespace` per body eval — that causes jumps).
- **Springs (the shipping values).** Asymmetric, ~0.4s each:
  - open → `.bouncy(duration: 0.4)`
  - close → `.smooth(duration: 0.4)`
  - compact↔expanded → `.snappy(duration: 0.4)`
  Wrap transitions in `withAnimation(...) { state = … }`. Gate the bounce behind
  `@Environment(\.accessibilityReduceMotion)` and fall back to `.smooth`/crossfade.
- **Micro-animations.** Use `phaseAnimator(_:trigger:)` (fires once per event, then idles)
  for the "pop" on a new track or a charging flourish — **never** `repeatForever`, and never
  a mounted `TimelineView(.animation)` while collapsed (both pin the render loop at refresh
  rate = phantom GPU/CPU).
- **Tahoe Liquid Glass.** For the expanded chrome use `.glassEffect(.regular, in: shape)`
  inside a single `GlassEffectContainer(spacing:)`, with `.glassEffectID(_:in:)` for
  glass-to-glass morphing. Remove redundant `NSVisualEffectView`s where glass shows (on
  Tahoe the menu bar is transparent and a visual-effect view will block glass). Don't stack
  glass-on-glass. (All `@available(macOS 26, *)` — fine, that's your floor.)

---

## 4. Deep dive: Now Playing (the flagship, and the biggest risk)

System-wide Now Playing is **broken for unentitled apps since macOS 15.4** —
`MRMediaRemoteGetNowPlayingInfo` returns nil (`mediaremoted` now enforces the Apple-only
`com.apple.mediaremote.*-read-access` entitlements; you cannot self-sign them). The only
working system-wide path on Tahoe is the **perl platform-binary loophole**:

**Primary path — `mediaremote-adapter`.**
- `/usr/bin/perl` reports bundle id `com.apple.perl` (a platform binary), so a process it
  hosts passes the daemon's entitlement check.
- Bundle two artifacts: `mediaremote-adapter.pl` (a Resource) and the prebuilt
  `MediaRemoteAdapter.framework` in `Contents/Frameworks` — **bundled but NOT linked**
  (do not add to "Link Binary With Libraries", or hardened-runtime/library-validation
  rejects it). Code-sign the framework.
- Easiest integration: add the SPM package `github.com/ejbills/mediaremote-adapter`,
  instantiate `MediaController()`, set `onTrackInfoReceived`, call `startListening()`.
  Under the hood it spawns `perl mediaremote-adapter.pl <framework> stream` and reads
  newline-delimited JSON (title/artist/album/duration/elapsed + base64 `artworkData`,
  plus `send`/`seek`/`shuffle`/`repeat` controls).
- At launch, run the adapter's `test` command (exit 0 = access works).

**Fallback path — AppleScript / ScriptingBridge.** If `test` fails (a future Apple break, or
a 26.x write/seek regression), fall back to per-app control for the two apps with scripting
dictionaries:
- Apple Music (`com.apple.Music`) and Spotify (`com.spotify.client`) via `SBApplication` /
  `NSAppleScript` (player state, track name/artist/album/duration, position, artwork).
- Drive updates push-style via `DistributedNotificationCenter` on
  `com.apple.Music.playerInfo` / `com.spotify.client.PlaybackStateChanged` (no polling).
- Needs `NSAppleEventsUsageDescription` + a per-target Automation TCC prompt.

**Abstraction.** Define a `MediaControllerProtocol` (current track, isPlaying, artwork,
play/pause/next/prev/seek) and select the concrete controller at runtime: adapter when
available, else Music/Spotify scripting (mirror boring.notch's controller-selection design).
Playback *control* (`MRMediaRemoteSendCommand`) still works even where reads don't, so keep
that as a backstop.

**v1 risk call:** the perl trick reads reliably on Tahoe 26.0; write/seek regressed on some
26.x point releases. Pin a known-good adapter fork, gate everything on `test`, and design
the UI to degrade gracefully (hide a seek bar you can't drive).

---

## 5. Deep dive: HUDs (volume / brightness) — overlay-only per your choice

You chose **overlay only, don't touch the system**, so the native macOS HUD will still show;
ours appears alongside it. That avoids the consuming-tap complexity and a known
brightness-stops-working bug. Implementation:

- **Trigger.** Install a **listen-only** `CGEventTap` (`.listenOnly`) on `NX_SYSDEFINED`
  (`NSEvent.EventType.systemDefined`, raw 14). In the callback wrap with `NSEvent(cgEvent:)`,
  act only when `subtype == 8` (aux control buttons), decode `data1`:
  `keyCode = (data1 & 0xFFFF0000) >> 16`, state `(data1 & 0xFF00) >> 8` (0xA=down). Key
  codes: `NX_KEYTYPE_SOUND_UP/DOWN/MUTE = 0/1/7`, `BRIGHTNESS_UP/DOWN = 2/3`.
  *Listen-only never consumes*, so the system still changes the value and draws its HUD.
- **Read current values (to render our overlay):**
  - Volume/mute via CoreAudio: default output device
    (`kAudioHardwarePropertyDefaultOutputDevice`), then
    `kAudioHardwareServiceDeviceProperty_VirtualMainVolume` (Float32 0–1) and
    `kAudioDevicePropertyMute`. Register `AudioObjectAddPropertyListenerBlock` so external
    changes update the overlay too. (Wrapper option: `rnine/SimplyCoreAudio`.)
  - Brightness (built-in) via the private `DisplayServices.framework`:
    `DisplayServicesGetBrightness(CGMainDisplayID(), &f)` — dlopen + declared symbol.
- **Overlay window.** A second borderless overlay (or reuse the notch panel's HUD slot) that
  fades in, shows a chiclet/bar, and auto-dismisses. Pure SwiftUI inside.
- **Permissions.** Listen-only needs **Input Monitoring** (`CGPreflightListenEventAccess` /
  `CGRequestListenEventAccess`). Periodically verify with `CGEvent.tapIsEnabled`; re-enable
  on `tapDisabledByTimeout`.

**Upgrade path (not v1):** if you later want the *clean single HUD*, switch the tap to
`.defaultTap`, return `nil` to swallow the key (this is what hides the native HUD without
SIP changes), and then you become responsible for applying the change yourself
(`AudioObjectSetPropertyData` / `DisplayServicesSetBrightness`) — with a read-back, or you
hit the boring.notch #1040 "key swallowed but brightness frozen" bug. Keep this isolated so
the switch is one flag.

---

## 6. Live activities & notifications

The morph engine already gives you the container; activities are just data.

- **Activity model.** `enum Activity { case media, charging, deviceConnected(Device),
  notification(Payload), timer, focus, … }` with priority + TTL. `ActivityManager` keeps the
  ordered queue; the topmost shows in the compact notch, others cycle (swipe-down / middle-
  click). Restore dismissed ones.
- **Sources (all event-driven):**
  - Charging / power: IOKit power-source run-loop source (see §7 battery).
  - Device connect / output switch: CoreAudio default-device listener + Bluetooth.
  - **Quick Peek notifications.** True system-notification *interception* needs private
    Bulletin/Notification-Center SPI and is fragile; for v1 generate Peeks from your own
    sources (battery, connect, focus, timer) and treat third-party notification mirroring as
    a later, clearly-scoped spike rather than a v1 promise.
- **Animations.** New activity = `phaseAnimator` pop; expansion = shared morph.

---

## 7. Tray + AirDrop (model on NotchDrop)

- **Inbound drop.** SwiftUI `.onDrop(of: [.data], isTargeted:)` on the panel. Resolve each
  `NSItemProvider` off-main (`loadObject(ofClass: URL.self)`, fall back to
  `loadInPlaceFileRepresentation(forTypeIdentifier: UTType.data.identifier)`), then **copy
  bytes into app storage immediately** (drag temp URLs are short-lived). Return `true` fast
  for the correct drop animation.
- **File promises** (images dragged from Photos/Mail/Safari): SwiftUI's `.onDrop` already
  fulfills them and hands you a temp URL containing `com.apple.SwiftUI.filePromises` — copy
  the bytes out synchronously inside the callback, then delete the temp. (AppKit canonical
  route: `NSFilePromiseReceiver` + `receivePromisedFiles(atDestination:…)`.)
- **Shelf model.** `TrayManager.shared` ObservableObject with an `OrderedSet<DropItem>`
  (swift-collections). Each `DropItem` copies the file to
  `Documents/CopiedItems/<uuid>/<name>`, snapshots a Quick Look preview
  (`QLThumbnailGenerator`), is `Codable` (persists across launches), with a TTL cleaner.
- **Outbound drag.** Quick win: conform `DropItem` to `Transferable` + `.draggable`, returning
  `FileRepresentation(contentType: .data, …) { SentTransferredFile(path, allowAccessingOriginalFile: true) }`.
  Upgrade to `NSDraggingSource` (`beginDraggingSession`) when you need multi-select,
  `ImageRenderer` previews, or auto-remove-on-successful-drop
  (`draggingSession(_:endedAt:operation:)`, gate on `!operation.isEmpty`).
- **AirDrop.** `NSSharingService(named: .sendViaAirDrop)` (confirmed **not** deprecated on
  macOS 26), guard `canPerform(withItems:)`, then `perform(withItems:)` to open the AirDrop
  sheet pre-loaded. Fallback: `NSSharingServicePicker(items:).show(relativeTo:of:preferredEdge:)`.
  - **Gotcha:** the share sheet must anchor to a window that can become key. Your panel is
    non-activating, so flip `canBecomeKey` true while presenting and keep the panel alive for
    the interaction (a small lifecycle delegate). This is the most likely integration bug.
- Not sandboxed → skip security-scoped bookmarks; plain file URLs + copied bytes are fine.

---

## 8. Widgets — data sources (ordered by permission friction)

Ship the zero-friction ones first.

- **Battery / charging / low-power (no permission).** `import IOKit.ps`:
  `IOPSCopyPowerSourcesInfo` → `IOPSCopyPowerSourcesList` → `IOPSGetPowerSourceDescription`;
  keys `kIOPSCurrentCapacityKey`, `kIOPSIsChargingKey`, `kIOPSTimeToEmptyKey`. Live updates
  via `IOPSNotificationCreateRunLoopSource` (no timer). Low-power:
  `ProcessInfo.isLowPowerModeEnabled` + observe `NSProcessInfoPowerStateDidChange`.
  Memory rule: `Copy*` → `takeRetainedValue()`, `Get*` → `takeUnretainedValue()`.
- **Calendar (standard TCC prompt).** Single `EKEventStore`,
  `try await store.requestFullAccessToEvents()`, `predicateForEvents(...)` +
  `events(matching:)`, observe `.EKEventStoreChanged`. Info.plist:
  `NSCalendarsFullAccessUsageDescription`. (There is no `contributesToCalendar` API — the
  model is `EKAuthorizationStatus.fullAccess/.writeOnly`.)
- **Weather — Open-Meteo (decided).** No paid Apple Developer account, so WeatherKit is out
  (it requires the `com.apple.developer.weatherkit` entitlement + mandatory attribution UI).
  Use **Open-Meteo** (`api.open-meteo.com/v1/forecast`, no key, no account): request
  `current=temperature_2m,weather_code` + `daily`/`hourly` as needed, and map the WMO
  `weather_code` to your own SF Symbols (no Apple condition enum). Get the location via
  `CLLocationManager`. Note Open-Meteo's free tier is non-commercial — fine for a personal app.
- **AirPods / Bluetooth battery.** No clean public API. Baseline: shell out to
  `system_profiler SPBluetoothDataType -json` off-main (~0.5–1s, cached) and read
  `device_batteryLevelMain/Left/Right/Case`. Magic peripherals: IORegistry
  `AppleDeviceManagementHIDEventService` → `BatteryPercent`. Live AirPods % needs CoreBluetooth
  Continuity-advertisement sniffing (`NSBluetoothAlwaysUsageDescription`) — port AirBattery's
  parser; treat as a later enhancement.
- **Focus mode.** `INFocusStatusCenter.default` gives only on/off (`isFocused`) +
  `NSFocusStatusUsageDescription`. The *specific* Focus name requires reading
  `~/Library/DoNotDisturb/DB/Assertions.json` → needs **Full Disk Access**. v1: show the
  on/off badge; gate the named-Focus behind an optional FDA onboarding.

---

## 9. Performance & memory discipline (the "low RAM, near-zero idle" mandate)

- **No polling.** Everything push-based: Combine publishers, `NSWorkspace.notificationCenter`,
  `DistributedNotificationCenter`, IOKit run-loop sources, CoreAudio listeners, async
  sequences. Debounce bursty events. Retain your `AnyCancellable` set or subscriptions die.
- **Stop work when hidden.** On collapse, `orderOut(nil)` the panel (a shrunk/alpha-0 window
  with a live animation still renders). Observe `NSWindow.didChangeOcclusionStateNotification`
  and pause visualizers when not `.visible`. Gate animating subviews behind `if isExpanded`.
- **Album art = the main RAM risk.** Never load full-res into `NSImage`. Downsample with
  ImageIO: `CGImageSourceCreateThumbnailAtIndex` with
  `kCGImageSourceThumbnailMaxPixelSize = maxDimension * scale`,
  `kCGImageSourceCreateThumbnailFromImageAlways: true`; wrap with `NSImage(cgImage:size:)`.
  Cache in a cost-limited `NSCache` (set `totalCostLimit`); front remote art with a
  `URLCache`. (3000×3000 cover ≈ 36 MB decoded vs ≈ 0.5 MB downsampled.)
- **Agent app.** `LSUIElement = true` (or `NSApp.setActivationPolicy(.accessory)`): no Dock
  icon, no app menu. Own an `NSStatusItem` for the menu-bar button + settings.
- **Measure in Release** with Instruments: Time Profiler (idle main thread parked, ~0% CPU),
  SwiftUI template (body re-eval counts), Animation Hitches / Core Animation FPS (60/120 with
  no hitches during the morph), Allocations + Mark Generation (art frees, no hosting-view
  leaks), Leaks (AppKit↔SwiftUI retain cycles), `powermetrics` for idle package power.

---

## 10. Project setup, signing, permissions

**Project.** Xcode app target, SwiftUI `App` lifecycle + `NSApplicationDelegateAdaptor`.
SPM packages: `mediaremote-adapter` (ejbills), `swift-collections`, optionally
`SimplyCoreAudio`. Bundle `mediaremote-adapter.pl` (Resource) + `MediaRemoteAdapter.framework`
(Frameworks, **not** linked, signed).

**Info.plist usage strings (TCC):**
`NSAppleEventsUsageDescription` (media fallback), `NSCalendarsFullAccessUsageDescription`,
`NSFocusStatusUsageDescription`, `NSBluetoothAlwaysUsageDescription` (if live AirPods),
`NSLocationWhenInUseUsageDescription` (weather location), `LSUIElement = true`.

**Entitlements / hardened runtime.** Developer-ID signed, hardened runtime ON, **App Sandbox
OFF**. Do not add `com.apple.security.app-sandbox`. The perl-spawn + private frameworks make
this **direct-distribution only** (no App Store — already your choice). Notarize the DMG.

**Permissions matrix:**

| Feature | Permission |
|---|---|
| HUD trigger (listen-only tap) | Input Monitoring |
| Media (adapter) | none (perl trick) |
| Media (fallback) | Automation (Apple Events) |
| Calendar | Calendars (full access) |
| Weather (Open-Meteo) | Location (optional) |
| AirPods live % | Bluetooth |
| Focus name | Full Disk Access |
| Battery, tray, AirDrop | none |

**TCC dev pain:** grants are keyed to the signing identity — ad-hoc re-signing during
development resets Input Monitoring/Accessibility/Automation repeatedly. Use a stable
Developer-ID identity locally to avoid re-granting every build.

---

## 11. Milestone roadmap (vertical slices)

Foundation → flagship → framework → breadth → polish. Each milestone is shippable/testable.

- **M0 — Skeleton & the notch (foundation).** Agent app, `NSStatusItem`, `NotchPanel`
  anchored to the real notch, `NotchShape` blob, hover-to-expand with the asymmetric-spring
  state machine. *Done when:* the empty notch expands/collapses buttery-smooth at ~0% idle.
- **M1 — Now Playing (flagship/highest risk first).** `mediaremote-adapter` + `test` gate +
  AppleScript fallback; compact now-playing + expanded player with `matchedGeometryEffect`,
  controls, downsampled art. *Done when:* track/art/controls work for Music, Spotify, and a
  browser; falls back cleanly when `test` fails.
- **M2 — Activity framework + Peeks.** Generalize activities (charging, device connect, own
  notifications), cycling, TTL. *Done when:* plugging in / connecting AirPods animates a card.
- **M3 — HUDs.** Listen-only tap, CoreAudio + DisplayServices reads, overlay render (native
  HUD coexists per your choice). *Done when:* volume/brightness keys show our overlay.
- **M4 — Tray + AirDrop.** Inbound drop + promises, shelf model + persistence, outbound drag,
  `sendViaAirDrop`. *Done when:* drag in → drag out / AirDrop round-trips.
- **M5 — Widgets.** Battery → Calendar → Weather (Open-Meteo) → AirPods battery → Focus badge.
- **M6 — Polish & hardening.** Instruments pass (idle CPU/RAM, leaks, hitches), Reduce Motion,
  Liquid Glass tuning, settings UI, onboarding/permissions flow.

---

## 12. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| MediaRemote perl loophole closes on an OS update | High | `test`-gate; AppleScript fallback; pin a known-good fork; control commands still work |
| Private SPI (`DisplayServices` brightness) breaks on 26.x point release | Med | Isolate behind one file; dlopen + guard; degrade gracefully (CGS/SkyLight already out of scope) |
| 4-area v1 scope creep | Med | Strict vertical slices M0–M5; each independently shippable |
| Share sheet won't anchor to non-activating panel | Med | Flip `canBecomeKey` during share; lifecycle delegate keeps panel alive |
| Idle CPU not actually zero (stray repeatForever/timer) | Med | No timers; Instruments Time Profiler each milestone; `orderOut` when hidden |
| Album-art RAM bloat | Low | ImageIO downsample + cost-limited NSCache (already specced) |

---

## 13. Open questions still to resolve (lower-stakes; decide during build)

Resolved: **Weather → Open-Meteo** (no paid account). **No fullscreen/lock-screen presence**
→ `collectionBehavior`-only, CGS/SkyLight out of scope. Remaining:

1. **Third-party notification mirroring:** is reflecting *other apps'* notifications as Quick
   Peeks required for v1, or are self-generated Peeks (battery/connect/focus/timer) enough?
   (Mirroring needs fragile private SPI — recommend deferring.)
2. **Build tooling:** plain `.xcodeproj`, or XcodeGen/Tuist for a checked-in, regenerable
   project? (Defaulting to a plain Xcode project unless you prefer generated.)
3. **Settings surface:** menu-bar dropdown only, or a full `Settings` window
   (`MenuBarExtra`/`Settings` scene)? Affects M6 scope.
```
