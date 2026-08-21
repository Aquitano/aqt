# Starboard — Manual Smoke Tests

The event tap cannot be CI-tested. Run this checklist after every phase.
Setup: Safari, Slack, Spotify running; Mail not running.

## Phase 1 — Core loop

- [ ] First launch without Accessibility permission shows the onboarding window;
      granting the permission live (no relaunch) closes it and switching works.
- [ ] rcmd+S focuses Safari (frontmost s-app).
- [ ] Repeated rcmd+S cycles Safari → Slack → Spotify → back to the hold's
      starting app, which then hides instead of re-focusing.
- [ ] rcmd+S while Safari is the only running s-app hides it; again brings it back.
- [ ] rcmd+M launches Mail from cold (not running).
- [ ] Left ⌘ shortcuts unaffected: ⌘C/⌘V copy-paste, ⌘Tab app switcher,
      ⌘Space Spotlight all behave normally.
- [ ] With rcmd NOT held, typing in a text field is 100% normal — no dropped or
      swallowed keys, including keyUps (type "the quick brown fox" quickly).
- [ ] Menu bar: Disable Starboard stops all interception; Enable restores it.
- [ ] Quit Starboard: keyboard fully normal.

## Phase 2 — Custom assignments

- [ ] rcmd+ralt+K pins frontmost app to K; toast confirms.
- [ ] Quit + relaunch Starboard: rcmd+K still focuses the pinned app.
- [ ] Pinned app closed: rcmd+K launches it.
- [ ] Settings shows assignment table with dynamic/custom badges; clear works.

## Phase 3 — Fuzzy search overlay

- [ ] Hold rcmd, type "xco" (Xcode installed): overlay appears after 2nd char,
      Xcode is the top hit; release rcmd → Xcode focuses.
- [ ] First letter still switches instantly (rcmd+s → Safari) without showing
      the overlay; releasing right away does not commit anything.
- [ ] Repeating one letter cycles (s,s,s → Safari→Slack→Spotify), query stays "s".
- [ ] Overlay never takes key focus: with a text caret blinking in a Safari
      field, hold rcmd + type — caret state is untouched, typing goes to search.
- [ ] Arrows/Tab move selection; selection wraps at both ends.
- [ ] Backspace edits the query; deleting to empty closes the overlay.
- [ ] Escape cancels; remaining keys of that hold pass through untouched.
- [ ] With a result selected: ⌘W closes its frontmost window, ⌘Q quits it,
      ⌘H hides it.
- [ ] Empty query / no matches shows the "No matches" state, release does
      nothing harmful.
