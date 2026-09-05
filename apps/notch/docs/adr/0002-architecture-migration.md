# 0002 In-place architecture migration

Status: accepted (September 2026)

## Context

After roughly two months of feature work the app is ~21k lines with one flat target, the
2019 observation model, ~60 hand-written preference keys, a two-level presentation state
synced through callbacks, and pointer truth split between SwiftUI and AppKit. A rewrite was
considered and rejected: the code encodes many macOS, TCC and SwiftUI workarounds that a
rewrite would have to rediscover.

## Decision

Migrate in place, one focused commit per item, tests green throughout:

1. Plan documents move to `docs/archive`; decisions live in `docs/adr`.
2. `@Observable` replaces `ObservableObject`/`@Published`/Combine; non-view observers use
   `Observations` sequences.
3. Preferences are one versioned `Codable` struct persisted as a single document.
4. The activity queue is generic: the channel key lives on the `Activity` value and the
   manager knows no feature by name.
5. Grace timers take an injected `Clock` so their logic is testable without sleeping.
6. Persistence and the agent config installer throw typed errors; failures land in a
   diagnostics store shown in Settings.
7. AppKit owns hover tracking and the drop destination; SwiftUI only renders content.
8. Multi-display presentation is one store keyed by display; hosts read a derived slice.
9. Sources are organised by feature, not by layer.
10. A Foundation-only `NotchCore` SwiftPM package holds models, policies, parsers and wire
    types. Tests use Swift Testing and run with `swift test`.
11. Swift 6 language mode.
12. Sparkle for updates, with a notarize workflow.

## Deviations while executing

- Item 7 moved hover tracking to AppKit but left the drop destination on SwiftUI's
  `.onDrop`. The tray ingestion pipeline is built around the `NSItemProvider` shapes SwiftUI
  hands it (file representations for Finder drags); rebuilding those from an `NSPasteboard`
  would have changed how dropped files are classified for no user-visible gain.
- Item 10 keeps `NotchState`, `NotchCoordinator`, the layout metrics and `HitRegion` in the
  app: they depend on SwiftUI (`withAnimation`), so the Xcode test bundle stays for them.

## Consequences

The pure/impure boundary becomes an import wall rather than a convention. Adding a
preference or an activity kind touches one file. Pointer and drop handling lose their
grace-timer workarounds. The cost is a large but mechanical diff and a manual verification
pass on real hardware for the window-layer changes.
