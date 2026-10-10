# Starboard manual smoke checklist

Run after meaningful changes. Prerequisites: Accessibility granted; Safari, Slack and Spotify running; "Switch to Desktop N" shortcuts enabled.

## Safety (always first)

- [ ] With Starboard running, normal typing in any app is unaffected.
- [ ] Left ⌘ shortcuts (⌘C, ⌘Tab, ⌘Space) all work as stock.
- [ ] Hold Right ⌘, type two letters, press Escape, then Q: the frontmost app must not quit.
- [ ] In Finder, hold Right ⌘, type S, then press Backspace twice: nothing moves to the Trash.
- [ ] Menu bar > Disable Starboard: every key passes through, Right ⌘ included.
- [ ] Hold Right ⌘, lock the screen, unlock, release: typing is normal and no overlay is left on screen.
- [ ] Right ⌘ + Tab shows the system app switcher; Right ⌘ + ↓ before the overlay appears reaches the app.

## Switching

- [ ] Right ⌘ + S focuses the S app; held Tab moves through Safari, Slack and Spotify in a stable order.
- [ ] Right ⌘ + S, S quickly: the second press steps to Safari's next window instead of re-focusing it.
- [ ] Right ⌘ + S then Right ⌘ + M within a fraction of a second: the M app keeps focus.
- [ ] With `repeatPress` set to `hide`, a second S hides Safari.
- [ ] Right ⌘ + Right ⌥ + K pins the frontmost app to K; the toast confirms and the config file shows the pin.
- [ ] Quit the pinned app; Right ⌘ + K launches it.
- [ ] A closed app that isn't pinned is not launched by its letter.

## Search and overlay

- [ ] Hold Right ⌘ for ~0.3 s: the overlay lists the letter map with nothing selected; release opens nothing.
- [ ] A pinned app shows its pinned letter in the letter map and in search results.
- [ ] Hold Right ⌘ and type "xco": the overlay appears at two characters with Xcode on top; release opens it.
- [ ] Right ⌘ + S released before ~0.3 s switches with no overlay flash.
- [ ] Queries containing w, q or h are typeable; Left ⌘ + W, Q or H act on the selection instead.
- [ ] The caret in a Safari text field keeps blinking while the overlay is up.
- [ ] Escape closes the overlay; releasing afterwards opens nothing.
- [ ] An excluded app gets no letter and never shows in search.

## Config

- [ ] Delete the config file and relaunch: it is written again with every key.
- [ ] Add `"c": "Google Chrome"` under `assignments` and save: Right ⌘ + C opens Chrome without a relaunch.
- [ ] Save a typo such as `"repeatPres"`: a toast and the menu name the key; switching keeps working with the previous config; pinning is refused until the file is fixed.
- [ ] Name an app that doesn't exist: a toast names it.

## Spaces

- [ ] Right ⌘ + 3 lands on Space 3; Right ⌘ + [ and ] move to the neighbouring Spaces.
- [ ] With two displays and separate Spaces, the jump happens on the display the pointer is on.

## Stages

- [ ] Caps Lock, then `=`: the save sheet lists the visible apps; the Caps Lock light never toggles.
- [ ] Save "Writing" on W with Notes and Safari and a URL under `open`; switch away; Caps Lock, W shows both and hides everything else.
- [ ] Quit Notes, then Caps Lock, W: Notes launches, ends up in front, and the URL opens.
- [ ] Caps Lock, `-` closes only the Stage's windows; the apps keep running.
- [ ] Caps Lock, then a letter with no Stage, in a text field: the letter is typed.

## Polish

- [ ] `mouseFollowsFocus` on: the pointer moves to the focused window after a switch, and not after Escape or a bare tap.
- [ ] Sleep and wake: shortcuts work immediately.
- [ ] Rebuild with `mise run starboard:install`: Accessibility stays granted.
