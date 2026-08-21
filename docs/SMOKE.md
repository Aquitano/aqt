# Starboard manual smoke checklist

Run after meaningful changes; each line maps to a phase acceptance criterion in
BATTLEPLAN.md. Prereq: Accessibility granted; Safari, Slack, Spotify running.

## Safety invariants (always first)

- [ ] With Starboard running, normal typing in any app is completely unaffected.
- [ ] Left ⌘ shortcuts (⌘C, ⌘Tab, ⌘Space) all work as stock.
- [ ] Hold rcmd, press Escape, then press Q — the frontmost app must NOT quit.
- [ ] Menu bar → Disable Starboard: everything passes through, including rcmd.

## Phase 1 — core switching

- [ ] rcmd+S focuses the best S app; rcmd+M launches Mail from cold.
- [ ] rcmd+S while an S app is focused hides it (toggle off in settings → cycles instead).
- [ ] rcmd held + Tab after S cycles Safari/Slack/Spotify in a stable order, wrapping past the third.

## Phase 2 — assignments

- [ ] rcmd+ralt+K pins the frontmost app to K; toast confirms.
- [ ] Quit and relaunch Starboard; rcmd+K still works, even launching the pinned app from cold.
- [ ] Settings shows the pin with a CUSTOM badge; Clear removes it.

## Phase 3 — search

- [ ] Hold rcmd, type "xco": overlay appears at 2 chars, Xcode on top; release focuses it.
- [ ] Queries containing w/q/h are typeable ("wha…"); left ⌘+W/Q/H act on the selection instead.
- [ ] The caret in a Safari text field keeps blinking while the overlay is up (never steals focus).
- [ ] Escape cancels; releasing afterwards focuses nothing.

## Phase 4 — windows

- [ ] rcmd+Tab (no letter first) shows visible windows, second selected; minimized windows absent.
- [ ] Selecting a background window raises exactly that window.
- [ ] Typing while cycling switches to fuzzy window search.
- [ ] Double-tap-and-hold rcmd lists windows only.
- [ ] rcmd+` cycles the frontmost app's windows.
- [ ] Without Screen Recording, windows show as "App Window"; with it, real titles.
- [ ] Window jump: enable in settings, ralt+S steps Safari's windows.

## Phase 5 — Spaces

- [ ] Compatible engine + ctrl+digit shortcuts enabled: rcmd+3 lands on Space 3.
- [ ] rcmd+[ and rcmd+] jump to adjacent Spaces.
- [ ] Instant engine: same jumps with no swipe animation; menu bar shows the Space number when enabled.
- [ ] ralt+2 (Instant + toggle on) moves the focused window to Space 2.

## Phase 6 — Stages

- [ ] Caps Lock tap, then `=`: save sheet lists visible apps; Caps Lock LED/state never toggles.
- [ ] Save "Writing" on W with Notes + Safari and a URL item; switch away; Caps Lock, W restores both, opens the URL, hides everything else.
- [ ] Repeat Caps Lock, W: re-hides intruders without reopening items.
- [ ] Caps Lock, `-`: closes only the Stage's windows; apps stay running.

## Phase 7 — polish

- [ ] Hold rcmd bare for ~0.5 s: hint grid appears, disappears on keypress/release.
- [ ] Mouse-follows toggle warps the pointer after a switch.
- [ ] Settings export produces JSON; import restores assignments and Stages.
- [ ] Dark and light system appearance both look intentional in settings.
