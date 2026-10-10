# Starboard

Switch apps by holding **Right ⌘** and pressing a letter. Starboard is a macOS menu bar app; the manual test checklist is [docs/SMOKE.md](docs/SMOKE.md).

## What it does

- **Right ⌘ + letter** focuses the app whose name starts with that letter. Pressing it again steps through the app's windows, most recent first, or hides the app or moves to the next app on that letter, depending on `repeatPress`. **Tab** while holding moves to the next app on the letter. A letter whose pinned app is closed launches it.
- **Right ⌘ + Right ⌥ + letter** pins the frontmost app to that letter, written to the config file.
- **Hold Right ⌘** past the overlay delay to see which app each letter opens. **Hold and type** to search running and installed apps; release to open the selection. Left ⌘ + W, Q or H close a window of, quit or hide the selected app.
- **Right ⌘ + 1…9** switches to that Space, **[** and **]** to the neighbouring one. They post Control + digit and Control + arrow, so "Switch to Desktop N" has to be on under System Settings > Keyboard > Keyboard Shortcuts > Mission Control.
- **Stages**: tap the leader key (Caps Lock), then `=` saves the visible apps as a workspace, a letter restores it (launching apps, opening files and URLs, hiding the rest), `-` closes its windows.

The menu bar menu turns Starboard off and on, opens the config file and sets launch at login. Starboard needs the **Accessibility** permission and asks for it on first launch.

## Config

`~/.config/starboard/config.json` is written with every key on first launch and reloaded whenever it changes. Apps are named by app name or bundle ID. A file that doesn't parse leaves the previous config in effect, or the defaults right after launch, and shows the error in the menu.

```json
{
  "assignments": { "c": "Google Chrome", "g": "Ghostty" },
  "excluded": ["Claude"],
  "launchIfNotRunning": true,
  "mouseFollowsFocus": false,
  "overlayDelayMs": 300,
  "repeatPress": "cycleWindows",
  "stages": [
    {
      "letter": "w",
      "name": "Writing",
      "apps": [{ "app": "Notes", "open": ["~/notes/draft.md"] }, { "app": "Safari" }]
    }
  ],
  "stagesLeader": "capsLock"
}
```

| Key                  | Values                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| `assignments`        | Letter to app. A pinned app owns its letter and no longer answers to its name letter.   |
| `excluded`           | Apps that get no letter and never show in search.                                       |
| `repeatPress`        | `cycleWindows`, `hide` or `cycleApps`.                                                  |
| `launchIfNotRunning` | Whether a letter launches its pinned app when it is closed.                             |
| `overlayDelayMs`     | 50 to 2000.                                                                             |
| `mouseFollowsFocus`  | Move the pointer to the focused window after a switch.                                  |
| `stagesLeader`       | `capsLock`, `rightShift` (a bare tap) or `off`.                                         |
| `stages`             | Saved with leader then `=`. `open` lists files or URLs opened when a launch was needed. |

## Development

Requires Xcode signed in to the Apple account of team `KRZZXX9G3M` (Xcode > Settings > Accounts). Builds are signed with its Apple Development certificate, which keeps the Accessibility grant across rebuilds. XcodeGen comes from mise.

From the workspace root:

```sh
mise run starboard:check    # lint, core tests and an unsigned app build
mise run starboard:dev      # build Debug and launch it
mise run starboard:install  # build Release into /Applications and launch it
```

`run.sh` behind them takes `--run` or `--install`.

Everything that can run without AppKit lives in `Packages/StarboardCore`: the key router, letter rules, search ranking and the config model. Its tests run with `swift test`. The app in `Starboard/` is the shell around it:

- `Input/EventTap.swift` runs the router on its own thread for every key event on the system and sends intents to the main actor. It must not allocate or do Accessibility, workspace, disk or UI work.
- `Switching/AppSwitcher.swift` carries the intents out.
- `Switching/WindowService.swift` runs window queries and Accessibility calls in order on a serial queue.

Starboard records intervals named `Event routing`, `Search ranking`, `Window enumeration` and `Installed app scan`, and an `Activation retry` event, on the Points of Interest track. To profile, run `mise run starboard:install` and attach Instruments' Time Profiler and Points of Interest to it. Event routing should stay under 0.1 ms at the median.
