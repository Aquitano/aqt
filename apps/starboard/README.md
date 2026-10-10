# Starboard

Switch apps by holding **Right ⌘** and pressing a letter. A native macOS menu bar utility with Raycast-inspired design. Feature spec and implementation phases live in [BATTLEPLAN.md](BATTLEPLAN.md); the manual test checklist is [docs/SMOKE.md](docs/SMOKE.md).

## What it does

- **rcmd+letter** focuses the app whose name starts with that letter, landing on its last-used window; press again to step through its other windows (or hide it / cycle same-letter apps, configurable); launches it if closed. **Tab** while holding cycles same-letter apps; **rcmd+ralt+letter** pins an app to a letter permanently.
- **Hold rcmd and type** for fuzzy search over apps and windows; release to focus. Left ⌘+W/Q/H close/quit/hide the selection.
- **rcmd+Tab** replaces Cmd-Tab with a window list (minimized and other-Space windows filtered); **rcmd+`** cycles the frontmost app's windows; double-tap-and-hold rcmd searches windows only.
- **rcmd+1…9** jumps to Spaces (**[** / **]** for adjacent), with an optional instant, animation-free engine; **ralt+1…9** moves the focused window (opt-in).
- **Stages**: tap the leader key (Caps Lock), then `=` saves the visible apps as a workspace, a letter restores it (launching apps, opening files/URLs, hiding the rest), `-` closes its windows.
- Holding rcmd alone opens the same overlay listing the letter map, mouse-follows-focus, JSON settings backup, launch at login.

## Development

Requires Xcode signed in to the Apple account of team `KRZZXX9G3M` (Xcode > Settings > Accounts). Builds are signed with its Apple Development certificate, which keeps the Accessibility grant across rebuilds. XcodeGen comes from mise.

From the workspace root:

```sh
mise run starboard:check    # lint and tests
mise run starboard:dev      # build Debug and launch it
mise run starboard:install  # build Release into /Applications and launch it
```

`run.sh` behind them takes `--run` or `--install`.

The repeatable performance workflow and signpost budgets are documented in
[docs/PROFILING.md](docs/PROFILING.md).

## Raycast helper mode

Launching the app with `--config <file> --socket <path>` runs it as a helper for a
Raycast extension: the engine is unchanged, the menu bar item steps aside, settings
come from the JSON config instead of UserDefaults and reload when it changes on
disk, and an owner-only unix socket takes live commands (status, enable, visible
apps, stage restore, search, focus, overlay). Adding `--search-deeplink <url>`
mirrors the hold overlay into a Raycast command instead of the native panel.

The extension itself is not in this repo yet.

The app needs the **Accessibility** permission (event tap) and optionally **Screen Recording** (window titles).
