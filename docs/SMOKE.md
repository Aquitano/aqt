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
