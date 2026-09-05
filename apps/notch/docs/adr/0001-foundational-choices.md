# 0001 Foundational choices

Status: accepted (June 2026, from the original build plan)

## Decisions

| Decision        | Choice                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Stack           | Swift, SwiftUI content hosted in an AppKit non-activating panel                                  |
| Min target      | macOS 26 only; no back-compat shims                                                              |
| Distribution    | Developer-ID signed, notarized, not sandboxed, direct download only                              |
| Now Playing     | `mediaremote-adapter` perl bridge, embedded but never linked; Music/Spotify AppleScript fallback |
| Window coverage | `collectionBehavior` only; no fullscreen or lock-screen presence, no CGS/SkyLight                |
| Native HUD      | Overlay by default; consuming the media keys is opt-in                                           |
| Weather         | Open-Meteo, no key                                                                               |
| Process model   | One agent process plus a tiny `notch-hook` client; no XPC services                               |
| Timers          | Push-based sources only; one-shot sleeps for TTLs and grace periods                              |
| Agent liveness  | Hooks announce sessions; a session lives as long as its process                                  |

## Why

A notch overlay needs non-activating panels, IOKit and CoreAudio run-loop sources,
ScreenCaptureKit audio and Liquid Glass. Every non-native stack would need a Swift shim
for all of that, so the shim would be the app. Targeting only the current macOS keeps the
SwiftUI surface modern and removes an entire class of availability branches.

See `docs/archive/BUILD_PLAN.md` for the full original reasoning.
