# Notch Apps — Feature Reference

> Combined feature reference for macOS notch / "Dynamic Island" apps, drawing on
> two leading examples: **Alcove** (<https://tryalcove.com>) and **NotchNook**.
> Each capability is tagged with its source — `(Alcove)`, `(NotchNook)`, or
> `(both)` — so the merged list stays accurate. Researched June 2026.
>
> Sources: official site & FAQ (tryalcove.com), the Alcove changelog
> (`henrikruscon/alcove-releases`), the Homebrew cask, and reviews (Today on Mac,
> MacSources, AlternativeTo); NotchNook features as described in product reviews.

---

## Core concept & design

- **Dynamic notch-style interface** at the top center of the screen. `(both)`
- **Real + virtual notch** — works with the real MacBook notch and creates a
  simulated notch / pill on Macs without one. `(both)`
- **Expand on interaction** — expands on hover or drag instead of opening a normal
  window. `(both)`
- **Two main areas** — **Nook** (widgets and controls) and **Tray** (files and
  transfer actions). `(NotchNook)`
- **Passive, context-aware** — gently fades in when needed and out when not,
  reacting to what you're doing instead of sitting always-on. `(Alcove)`
- **Customizable layout** — widget arrangement and interface size. `(NotchNook)`
- **Native & lightweight** — written entirely in Swift, no web views; very low
  resource/energy use (near 0% CPU idle, ~80 MB RAM). `(Alcove)`

## Media / Now Playing

- **Music & media controls** in the notch. `(both)`
- **Playback actions** — play, pause, skip forward/back. `(both)`
- **Current media display** — track details and album art. `(both)`
- **Source support** — Apple Music and Spotify (early reviews), with broader
  system-wide media detection in later coverage. `(NotchNook)`
- **Broad source support** — any app via the macOS Now Playing system: Apple
  Music, Spotify, YouTube / YouTube Music, podcasts, live streams, browsers.
  `(Alcove)`
- **Extended controls** — shuffle, repeat, draggable seek slider, playback speed.
  `(Alcove)`
- **Audio visualizer** — iOS-matched waveform/spectrogram. `(Alcove)`
- **Artwork effects** — glare, opacity-on-pause, grayscale, clear-artwork,
  progressive blur. `(Alcove)`
- **Audio format badges** — Lossless and Dolby Atmos (Dolby symbol). `(Alcove)`
- **Explicit-content tag** on the player and lock screen. `(Alcove)`
- **Copy link / open in browser** for the current track. `(Alcove)`

## Nook — widgets

- **Calendar widget** — upcoming events and date viewing. `(both)`
  - Alcove adds: Apple Calendar / Fantastical / Notion support, join-meeting
    button, time-to-leave alerts, all-day & multi-day handling, color options.
- **Shortcuts widget** — launch macOS or Siri Shortcuts directly from the notch.
  `(NotchNook)`
- **Mirror widget** — quick webcam preview before calls. `(NotchNook)`
- **Notes widget** — noted in later coverage. `(NotchNook)`
- **Weather widget** — multiple styles, metric/imperial, precipitation, day/night,
  show-on-empty-calendar-days. `(Alcove)`
- **Focus mode widget** — current Focus state, custom Focus modes, sleep-focus
  sound. `(Alcove)`
- **Battery & devices** — charging status/animations, battery widget with
  time-to-empty, low-power-mode and low-battery alerts. `(Alcove)`
- **AirPods / Bluetooth** — connection cards with a 3D device model and per-device
  battery (AirPods Max, AirPods Pro 3, AirPods 3/4, EarPods, HomePod). `(Alcove)`

## Tray — files

- **Temporary file tray** — drag and hold files in the notch. `(NotchNook)`
- **Multi-item staging** — store multiple files and folders for short-term staging.
  `(NotchNook)`
- **Use anywhere** — files in the tray can be previewed, opened, or dragged into
  other apps. `(NotchNook)`
- **Cross-app / cross-space** — move files between apps or spaces without keeping
  Finder open. `(NotchNook)`

## AirDrop

- **Dedicated AirDrop target** inside the Tray. `(NotchNook)`
- **Drag-to-notch AirDrop** — drag a file to the notch and drop it on the AirDrop
  area to trigger macOS AirDrop directly. `(NotchNook)`
- **AirDrop from the tray** — send files already sitting in the tray. `(NotchNook)`
- One of the most frequently highlighted features in reviews, because it removes
  the usual Finder or share-menu steps. `(NotchNook)`

## Notifications & live activities

- **Animated notifications ("Quick Peek")** — system notifications become animated
  mini-cards at the notch, configurable duration. `(Alcove)`
- **Smart alerts** — battery, connectivity, focus, display, sound events.
  `(Alcove)`
- **Multiple simultaneous live activities** — track several at once (media,
  downloads, timers, progress); cycle via swipe-down or middle-click, restore
  dismissed ones. `(Alcove)`

## HUDs (system overlays)

- **Custom volume HUD** — replaces the native one; notch-anchored, decibel-style
  option, mute state, control from the HUD. `(Alcove)`
- **Custom brightness/display HUD** — glow option, display symbol, external-display
  and external-keyboard brightness, `ctrl`+brightness control. `(Alcove)`
- **HUD customization** — animation speed (smooth/fast/instant), percentage,
  hide-labels, disable syncing. `(Alcove)`

## Lock screen

- **Lock-screen presence** — custom widgets/visuals (now playing, focus, weather),
  a lock-screen media player with album art, keep-awake on lock, lock/unlock
  sounds, show-on-screensaver. `(Alcove)`

## Interaction & gestures

- **Expand on hover / drag** instead of opening a window. `(both)`
- **Swipe gestures** — skip tracks, dismiss activities, swipe-down to cycle/expand,
  swipe to collapse; adjustable sensitivity and "natural movement". `(Alcove)`
- **Quick interactions** — middle-click to cycle activities; media controllable via
  keyboard shortcut. `(Alcove)`

## Display & notch customization

- **Simulated notch / pill** — force-enable a simulated notch or a pill on
  notchless displays; physical notch not required. `(both)`
- **Duo mode** — alternate layout option. `(Alcove)`
- **Notch sizing** — tune width/height, pick the preferred display, restrict
  widgets to the primary screen. `(Alcove)`
- **Interface size & widget arrangement** — customizable layout. `(NotchNook)`
- **External display support** — Studio Display XDR, MacBook "Neo", external
  displays (incl. BetterDisplay). `(Alcove)`

## System behavior & privacy

- **Menu bar item** — exposes media/controls; icon can be hidden (since macOS
  Tahoe). `(Alcove)`
- **iCloud settings sync** across devices. `(Alcove)`
- **Visibility controls** — hide from screen capture, hide in Mission Control,
  hide/disable in fullscreen, hide-while-inactive. `(Alcove)`
- **Privacy-respecting** — listens to system state rather than capturing
  keystrokes; collects no personal data. `(Alcove)`
- **Launch at login** plus guided onboarding for Bluetooth, Accessibility, and
  Calendar permissions. `(Alcove)`
- **Sound effects / haptics** — system-sound alerts and previews; haptic feedback
  for Quick Peek. `(Alcove)`

---

## Where the two apps differ

NotchNook leans **productivity / file-management** (Nook + Tray, file shelf,
AirDrop, Mirror, Shortcuts, Notes). Alcove leans **experience / ambiance** (live
activities, polished animations, rich media, HUDs, lock screen). Notably:

- **Alcove does not include** a file tray, drag-to-notch AirDrop, a camera/mirror
  view, a Shortcuts launcher, or a standalone timer — these are NotchNook's domain.
- **NotchNook coverage here does not detail** Alcove's HUD replacement, multiple
  simultaneous live activities, lock-screen widgets, or its breadth of media
  effects.

---

## Platform & requirements

### Alcove

- **macOS 15 (Sequoia) or later**; notch not required.
- Native Swift app, distributed as a DMG (not the Mac App Store);
  `brew install --cask alcove`.
- Permissions used as needed: Accessibility (HUDs), Bluetooth (devices), Calendar,
  Location (weather).
- Reliability caveat: relies on private Apple APIs; provided as-is. Release repo
  archived June 1, 2026 (hosted v1.7.2; Homebrew cask reached 1.7.5).
