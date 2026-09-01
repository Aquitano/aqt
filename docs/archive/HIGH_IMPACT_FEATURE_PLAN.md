# High-Impact Feature Expansion Plan

Implementation plan for three connected investments:

1. External displays and a virtual notch.
2. Rich, risk-aware coding-agent permission requests.
3. A workflow-grade tray.

This plan assumes the current macOS 26-only, direct-distribution architecture. It preserves
the app's event-driven behavior, near-zero idle work, pixel-art iconography, and the rule that
file/process work stays off the main actor.

## 1. Outcomes and boundaries

### Product outcomes

- Notch remains useful when the Mac is docked, when the built-in display is closed, and on a
  Mac or display without a physical notch.
- Agent permission prompts explain exactly what is being requested before the user acts.
- The tray becomes a temporary workspace for files, images, text, and links rather than only
  a file shelf.

### Non-goals

- No lock-screen or private CGS/SkyLight space injection.
- No system-notification mirroring.
- No permanent document library or cloud sync for tray contents.
- No automatic or remembered agent approvals. "Approve once" answers only the currently
  blocked request.
- No attempt to infer that a command is safe. Unknown or ambiguous requests are classified
  conservatively.
- No automatic screenshot copying without an explicit opt-in and an explicit Add action.

### Shared engineering constraints

- Managers remain `@MainActor ObservableObject`s. Display enumeration, command analysis,
  archive creation, file copying, metadata reads, and screenshot observation run in pure
  helpers or dedicated workers.
- Display and tray logic must be expressed as pure value transformations where possible so
  the hostless `NotchTests` target can exercise it.
- Adding production sources requires updating `project.yml`, regenerating the checked-in
  project with `xcodegen generate`, and keeping the explicit `NotchTests` source list in sync.
- All new custom UI symbols use `PixelIcon`. Thumbnails and previews remain native content.
- User-owned agent configuration and original files must never be mutated without an
  explicit user action.

## 2. Recommended delivery order

| Milestone | Scope | Why this order |
|---|---|---|
| M1 | Display identity, selection, and single-panel migration | Establishes stable display behavior without multi-window complexity. |
| M2 | Virtual pill profiles and active-display following | Completes the most valuable single-display modes. |
| M3 | All-displays panel coordinator | Builds multi-panel support on tested display policy and geometry. |
| M4 | Structured permission payload and risk engine | Security-sensitive data work lands before UI actions depend on it. |
| M5 | Permission request card and actions | Delivers the complete agent workflow. |
| M6 | Tray model v2 and common ingestion pipeline | Creates the migration-safe base for every tray feature. |
| M7 | Quick Look, clipboard, rich items, and actions | Delivers the highest-frequency tray improvements. |
| M8 | Collections, visible expiry, and Option-move | Adds organization and lifecycle controls. |
| M9 | Screenshot candidates in the compact pill | Lands after rich ingestion and activity actions exist. |

M1-M3, M4-M5, and M6-M9 are separate vertical tracks. They may be developed independently,
but each milestone should merge only when its own acceptance criteria pass.

---

# Track A: External Displays and Virtual Notch

## A1. Product behavior

Add a Display section to Settings with these controls:

- **Show Notch on:** Built-in display, main display, all displays.
- **Follow active display:** optional; disabled when "all displays" is selected.
- **Virtual notch:** Automatic, always, never. Automatic uses a virtual pill only when the
  target screen has no physical notch.
- **Per-display profile:** compact width, compact height, horizontal offset, vertical offset,
  expanded width, and Reset.
- A small live preview that distinguishes a physical notch from a virtual pill.

Definitions must be precise:

- **Built-in display:** the online screen whose `CGDisplayIsBuiltin` value is true. If it is
  unavailable, fall back to the main display rather than hiding the app.
- **Main display:** `NSScreen.main`, updated when macOS moves the menu bar.
- **Active display:** first the display containing the pointer; while the user is typing or a
  key-capable Notch surface is open, keep the current target stable. A frontmost-window screen
  may be used as a fallback only when it can be determined without Accessibility permission.
- **All displays:** one compact hover target per selected online display. Only one panel may be
  expanded or key-capable at a time.

## A2. Architecture

### Stable display identity

Introduce `DisplayDescriptor`, a Sendable value containing:

- Stable UUID from `CGDisplayCreateUUIDFromDisplayID`.
- Current `CGDirectDisplayID`.
- Frame, visible frame, backing scale, safe-area insets, and built-in/main flags.
- Human-readable name.
- Whether a physical notch is present.

Do not persist `NSScreen` instances, array positions, or frame coordinates as identity. Create
a `DisplayInventory` helper that maps the current `NSScreen.screens` snapshot into descriptors.
Persist profiles by display UUID. If a UUID cannot be obtained, derive a fallback key from
vendor, model, serial, and display name, and treat it as best-effort.

### Display policy

Add pure types:

```swift
enum DisplayPlacement: String, Codable {
    case builtIn
    case main
    case all
}

enum VirtualNotchMode: String, Codable {
    case automatic
    case always
    case never
}

struct DisplayProfile: Codable, Equatable {
    var displayKey: String
    var compactWidthAdjustment: Double
    var compactHeightAdjustment: Double
    var horizontalOffset: Double
    var verticalOffset: Double
    var expandedWidthAdjustment: Double
}
```

`DisplaySelectionPolicy.resolve(...)` accepts inventory, placement, active display, and last
valid target. It returns an ordered set of target descriptors plus a migration reason. Keep
selection independent from AppKit so disconnect/reconnect permutations are table-testable.

### Geometry

Refactor `ScreenGeometry.current()` into:

```swift
static func make(
    for display: DisplayDescriptor,
    profile: DisplayProfile,
    virtualMode: VirtualNotchMode
) -> ScreenGeometry
```

Geometry rules:

- A real notch always preserves at least the measured camera-housing gap. "Always virtual"
  may change the surrounding pill chrome and configured size, but never draws interactive
  content beneath the physical notch.
- A notchless target uses the fallback pill metrics plus the display profile.
- Horizontal offsets are clamped so the expanded panel remains inside the display frame.
- Vertical offsets are clamped to a small range near the top edge; the panel must never create
  an invisible hover target.
- Size adjustments have documented minimum and maximum values. The physical notch gap must
  never be made smaller than the actual camera housing.
- Hit-region calculations continue to consume the exact same geometry as SwiftUI.

### Window ownership

Split the current `NotchWindowController` into:

- `NotchWindowCoordinator`: observes display inventory and selection policy, creates/removes
  panel hosts, chooses the active host, and routes global pointer/drag events.
- `NotchPanelHost`: owns one `NotchPanel`, hosting view, geometry, mouse passthrough, and
  occlusion state for one display.
- `NotchInteractionCoordinator`: ensures only one host is expanded, handling a drop, editing
  text, previewing, or presenting a share sheet.

The existing single-panel implementation should become one `NotchPanelHost` before enabling
all-displays mode. This makes M1 behavior-preserving and keeps M3 a controlled multiplication
of an already-tested host.

Shared state rules in all-displays mode:

- Media, activities, agents, widgets, and tray data are shared through `AppEnvironment`.
- Presentation is per host: every host may be compact, but only the interaction host expands.
- Selecting a tab on one host becomes the shared preferred tab for the next expansion.
- HUDs appear on the active display only, never duplicated across every panel.
- A drag opens only the host whose catch region contains the pointer.
- Global hotkey opens the active target. A second press hides every host.
- Rendering-heavy work is active if at least one relevant host is visible and unoccluded.
  Audio capture still runs once, never once per display.

## A3. Automatic migration

Observe `NSApplication.didChangeScreenParametersNotification`, debounce for 150-250 ms, and
recompute inventory once per burst.

Migration transaction:

1. Snapshot the currently expanded host, active tab, drop/share/editing state, and target UUID.
2. Resolve the new target set with `DisplaySelectionPolicy`.
3. If the current target remains valid, update its geometry in place.
4. If it disappeared, collapse or end transient interaction safely before removing its panel.
   Never move an active share sheet, Quick Look panel, text editor, or inbound drop halfway
   through the interaction.
5. Create/update replacement hosts off the inventory snapshot.
6. Restore compact visibility immediately. Restore expansion only when it was user-pinned or
   hotkey-opened; hover expansion should collapse during migration.
7. Recompute passthrough and rendering activity after all frames are installed.

When the lid closes, built-in placement falls back to main. When the built-in display returns,
the app migrates back only after the display topology has remained stable for the debounce
window. Do not animate a panel through global screen coordinates; close on one screen and
morph open on the other.

## A4. Settings and persistence

Add settings keys for placement, follow-active, virtual mode, and encoded display profiles.
Profiles should be written as a versioned JSON value rather than one `UserDefaults` key per
screen property. Unknown profile fields must be ignored on downgrade/upgrade.

Changing placement or virtual mode applies live. While a settings slider is being dragged,
throttle geometry application to the display refresh cadence and persist only the final value.

## A5. Display tests

Hostless tests:

- Built-in selection with built-in present, absent, and reconnecting.
- Main-display changes.
- All-display ordering and deduplication.
- Follow-active hysteresis and fallback when the pointer crosses a boundary.
- Stable UUID profile lookup after screen ordering changes.
- Physical versus virtual geometry.
- Offset and size clamping on small, scaled, portrait, and negative-origin displays.
- Removal of an expanded target produces a safe migration instruction.
- `HitRegion` remains inside each host's panel and centered on the adjusted notch.

Manual matrix:

- Built-in only; external only with lid closed; built-in plus one external; two externals.
- Display arranged left, right, and above the built-in display.
- Different scaling factors and portrait rotation.
- Menu bar moved between displays.
- Connect/disconnect while compact, expanded, dragging, sharing, previewing, and editing.
- Full-screen app on one display while another remains visible.
- Sleep/wake and login launch while docked.

## A6. Display acceptance criteria

- No panel is stranded off-screen after any display topology change.
- Built-in/main modes own exactly one panel; all mode owns exactly one panel per target.
- Only one panel can be expanded or key-capable.
- Active-display following does not bounce while the pointer crosses the top-screen boundary.
- Real-notch geometry cannot expose content under the physical camera housing.
- Idle CPU and render activity do not scale materially with the number of compact, unchanged
  displays.
- Existing single-display hover, drop, HUD, share-sheet, and hit-region behavior remains intact.

---

# Track B: Rich Agent Permission Requests

## B1. Product behavior

Replace the current one-line permission detail with a structured permission card showing:

- Agent, project, branch, and terminal.
- Tool name and operation category.
- Exact command in a horizontally scrollable, selectable monospace field.
- Affected path or paths, with project-relative display where possible and full path available.
- Working directory.
- Risk badge: Low, Medium, High, or Unknown.
- Short, deterministic reasons such as "writes outside project," "uses administrator
  privileges," or "deletes files recursively."
- A visible expiry/countdown while the socket can still answer.

Actions:

- **Approve once:** answers only this request with `allow`.
- **Deny:** answers with `deny`.
- **Jump to Terminal:** uses the existing terminal focus route without answering.
- **Copy Summary:** writes a plain-text audit summary to the pasteboard without answering.

If the 120-second reply window expires, disable Approve/Deny, keep Jump and Copy available,
and say "Continue in Terminal." Never imply that a response was delivered until the socket
completion reports success.

## B2. Structured wire model

Stop encoding security-relevant content only into `message`. Extend `HookEnvelope` with an
optional, versioned permission payload that remains Foundation-only and Codable so both the
app and `notch-hook` can compile it:

```swift
struct AgentPermissionRequest: Codable, Equatable, Sendable {
    var schemaVersion: Int
    var requestId: String
    var toolName: String?
    var operation: AgentPermissionOperation
    var command: String?
    var paths: [String]
    var url: String?
    var description: String?
    var rawInputSummary: String?
    var requestedAt: Date
    var replyDeadline: Date
}
```

Do not forward arbitrary raw JSON or secrets. Extract only allowlisted fields from the hook
input, cap every string and array, remove control characters, and cap the entire encoded
envelope. Preserve the exact command up to a documented maximum (for example 8 KiB); if it is
truncated, mark that visibly and force risk to Unknown or High.

Provider capability rules:

- Claude's blocking `PermissionRequest` supports all four actions.
- Providers that report permission requests but cannot receive an in-notch decision show the
  same detail card with Jump and Copy only.
- Never synthesize approval support for a provider merely because it emitted a waiting state.

## B3. Path extraction and normalization

At hook time, extract paths from structured tool inputs first:

- `file_path`, `path`, `paths`, `directory`, `destination`, and known edit/move fields.
- For Bash/shell, retain the exact command and run conservative token analysis only to find
  likely path operands and risk signals. Do not execute the command and do not claim to fully
  parse shell syntax.

At app time, normalize extracted paths lexically against the request `cwd`:

- Standardize `.` and `..` without resolving symlinks as proof of safety.
- Mark project-relative, outside-project, home-directory, system, removable-volume, and
  unknown scopes.
- Never read file contents for classification.
- Treat unresolved variables, command substitution, globs, redirects, and here-documents as
  ambiguity signals.

Show the explicit affected path supplied by the agent even when risk analysis cannot verify
it. Label inferred shell paths as "Possible paths" rather than "Affected paths."

## B4. Deterministic risk engine

Implement `PermissionRiskClassifier` as a pure Foundation module. It returns level plus a list
of reason codes. The UI converts reason codes to localized copy.

Suggested baseline policy:

### High

- Recursive or forceful deletion, disk formatting, partitioning, or filesystem erase.
- `sudo`, privilege escalation, launch daemon/agent mutation, or writes to system locations.
- Writes outside the project working tree unless the tool explicitly targets a user-selected
  destination.
- Credential/keychain/SSH/config access with a write or exfiltration-capable operation.
- Download-and-execute patterns, shell evaluation of network output, or opaque encoded scripts.
- Permission changes that broadly grant execute/write access.

### Medium

- Network requests, package installation, process termination, git push, or external side
  effects.
- Rename/move/delete inside the project.
- Writes to user configuration files.
- Commands with redirects, pipes, globs, variables, or multiple shell statements where the
  final effect is not fully known.

### Low

- Read-only operations on explicit paths inside the project.
- Creation or edits to explicit files inside the project with no shell ambiguity and no
  sensitive path.
- Known local build/test commands without network, privilege, or destructive indicators.

### Unknown

- Missing or truncated command/input.
- Unsupported tool or unparseable structure.
- Conflicting signals or no defensible classification.

Risk is advisory, never authorization. The card must say why a level was assigned and must not
use reassuring language such as "safe."

## B5. State and UI integration

Add the structured request to `AgentSession` or store it in a dedicated
`PendingAgentPermission` collection keyed by request ID. Prefer a dedicated collection because
the open socket, deadline, delivery state, and audit summary belong to a request rather than to
the long-lived session.

Request state machine:

```text
pending -> responding -> approved
                     \-> denied
                     \-> deliveryFailed -> expired
pending -----------------------------> expired
```

Rules:

- Disable both decision buttons during `responding` to prevent duplicate replies.
- Remove the socket entry exactly once.
- Keep the final state briefly so success/failure feedback is visible, then return the session
  to provider-driven state.
- The compact pill prioritizes the oldest unanswered high/unknown-risk request, then other
  unanswered permission requests.
- Auto-expand, when enabled, opens the Agents tab focused on that request.

Use a dedicated `AgentPermissionCard` rather than expanding `AgentRowView` indefinitely.
Collapsed rows retain the existing project/status summary; selecting a pending row opens the
card inside the notch. Copy Summary should include agent, project, cwd, tool, exact command,
paths, risk, reasons, request time, and whether the request is still actionable.

## B6. Security and privacy requirements

- Permission approval remains opt-in and defaults off.
- Exact commands are displayed locally and are not written to persistent logs.
- OSLog entries contain request IDs and state transitions, not command text or paths.
- Copy Summary is the only explicit clipboard write.
- No approval history containing commands is persisted in v1.
- A request from an unrecognized peer/provider is view-only and cannot be approved.
- Keep the existing bounded socket timeouts and fail-open-to-terminal behavior: if Notch is
  unavailable, the agent must fall back to its own prompt rather than hang or auto-approve.

## B7. Permission tests

Hostless fixtures:

- Hook extraction for Bash, edit/write, URL, move, and unknown tools.
- String/array/envelope size caps and control-character stripping.
- Relative path normalization, outside-project traversal, symlink ambiguity, and home/system
  scopes.
- Every risk rule and precedence when low/high signals conflict.
- Shell ambiguity: pipes, redirects, substitutions, variables, quoting, and multiple commands.
- State-machine duplicate clicks, delivery failure, timeout, and late provider events.
- Codable compatibility when old clients send only `message`.
- Providers without reply capability never expose Approve/Deny.

Manual checks:

- Approve, deny, jump, and copy while the request is live.
- Request expires with the notch open and closed.
- App quits, agent watching is paused, or socket restarts during a request.
- Multiple simultaneous requests from different sessions.
- VoiceOver reads risk, command, paths, deadline, and actions in a sensible order.

## B8. Permission acceptance criteria

- The displayed command matches the allowlisted hook payload and truncation is explicit.
- Structured affected paths are shown; inferred shell paths are never presented as certain.
- Every risk badge has at least one visible reason, except Unknown which explains the missing
  evidence.
- Approve means approve once; there is no remembered allow rule.
- Duplicate actions cannot send multiple socket responses.
- An expired or unsupported request cannot display enabled decision buttons.
- No command/path contents appear in persistent logs or settings.

---

# Track C: Workflow-Grade Tray

## C1. Model v2 and migration

The current `DropItem` assumes every item is a copied file. Introduce a versioned tray store:

```swift
struct TrayStore: Codable {
    var schemaVersion: Int
    var collections: [TrayCollection]
    var items: [TrayItem]
}

enum TrayItemKind: Codable, Equatable {
    case file
    case image
    case text
    case url
}

struct TrayItem: Identifiable, Codable, Equatable, Hashable {
    var id: UUID
    var kind: TrayItemKind
    var displayName: String
    var relativePath: String?
    var text: String?
    var sourceURL: String?
    var typeIdentifier: String
    var byteSize: Int64
    var addedAt: Date
    var expiresAt: Date?
    var collectionID: UUID
    var isPinned: Bool
}
```

Keep payload bytes in the existing managed storage root. Materialize text as UTF-8 `.txt`, URL
items as `.webloc` or a small internal representation only when an outbound file is required,
and clipboard images as PNG while preserving a more specific source type when available.

Migration requirements:

- Decode the current `[DropItem]` store and map every entry to the default collection.
- Preserve IDs, relative paths, byte sizes, timestamps, thumbnails, and effective TTL.
- Write v2 only after migration succeeds; retain a one-time backup of the old JSON until a
  subsequent clean launch.
- Missing/corrupt item files are quarantined from the visible model and reported without
  deleting unrelated stored folders.

Introduce one `TrayIngestionPipeline` for drag, paste, screenshot, and generated archive
inputs. It validates, materializes bytes off-main, builds metadata, commits the model on the
main actor, and requests a thumbnail. One ingestion path avoids four subtly different storage
and cleanup behaviors.

## C2. Selection and Quick Look

Add single and multi-selection to `TrayView`:

- Clicking selects; Command-click toggles; arrow keys move selection.
- Space opens Quick Look for the selected item(s).
- Double-click opens the item with its default app.
- Escape closes Quick Look before collapsing the notch.

Use `QLPreviewPanel` or `QLPreviewView` backed only by managed file URLs. Add a `previewing`
key-capability latch to `NotchPanel`, parallel to share-sheet and text-editing latches. The
display coordinator must pin migration while the preview is active.

Text and URL items need preview adapters:

- Text may use its materialized `.txt` file.
- URL may preview an internal `.webloc` representation or show the URL card when Quick Look
  has no useful representation.

Quick Look must close when the item is removed, expires, moves collections, or its backing URL
changes during rename.

## C3. Paste from clipboard

Add a Paste button and support Command-V while the tray is active. Read `NSPasteboard.general`
in this order:

1. File URLs.
2. Image data.
3. Web URL.
4. Plain text.

Show a lightweight confirmation only for a large batch or payload above a configured size.
Do not monitor clipboard changes continuously; paste is user-triggered and therefore has no
idle CPU or clipboard-privacy cost.

Deduplicate identical file URLs within one paste operation, but allow the user to add the same
content again later. Report partial failures as one activity summary rather than one alert per
item.

## C4. Rich drag and drop

Expand accepted UTTypes from file URLs to URL, plain text, UTF-8 text, and common image types.
Update both the AppKit drag catch check and SwiftUI drop registration from the same pure
`TrayDropCapabilities` definition so they cannot disagree.

Drop chooser copy should adapt to content:

- File/image: "Keep" and configured "Share."
- URL: "Keep Link" and "Open/Share."
- Text: "Keep Text" and "Share."

Drag-out behavior:

- Files/images expose managed file URLs.
- URLs expose both `.url` and plain text.
- Text exposes plain text and a temporary `.txt` representation for file-only targets.

## C5. Named temporary collections

Add `TrayCollection` with ID, name, creation date, optional expiry override, and sort order.
There is always a non-deletable "Shelf" default collection.

UX:

- Collection switcher at the top of the Tray tab.
- New, rename, reorder, and delete collection actions.
- Drag selected items onto a collection to move them.
- Deleting a non-empty collection asks whether to move items to Shelf or delete them.
- Compact pill and status menu show the total item count; the expanded tray initially opens
  the last-used collection.

Keep the first version local and flat. No nested collections, tags, smart folders, or cloud
sync.

## C6. Item actions

Provide these actions through a compact selection toolbar and context menu:

- **Quick Look**.
- **Open** / **Open Link**.
- **Reveal in Finder** for materialized items.
- **Compress** selected items into one ZIP.
- **Copy Path** for one item; **Copy Paths** newline-separated for several.
- **Copy Content** for text/URL items.
- **Rename**.
- **Share** through the existing share coordinator.
- **Move to Collection**.
- **Pin / Unpin**.
- **Remove**.

Implementation rules:

- Archive off-main using `/usr/bin/ditto` or Foundation APIs with explicit argument arrays,
  never shell interpolation. Add the resulting ZIP through the common ingestion pipeline.
- Rename validates forbidden names, collisions, and empty values; rename the managed file and
  thumbnail sidecar as one recoverable transaction, then persist metadata.
- Copy Path writes absolute managed paths deliberately. Make clear these are Notch-owned
  temporary copies, not the original source paths.
- Share reuses the current key-window lifecycle and clears only share-staging copies.
- Batch actions return one aggregated success/failure result.

## C7. Option-drag move semantics

Option-drag is explicitly destructive and must be handled differently from a normal provider
copy.

- Detect the Option modifier at drop commitment, not only at drag entry.
- Show "Move to Shelf" in the chooser and use a `.move` proposal when the source supports it.
- Move is available only for real file URLs whose original source can be identified. Text,
  image-data-only, virtual providers, and promised files remain copy-only.
- Use `NSFileCoordinator` for source access. Prefer a filesystem move when possible; for a
  cross-volume move, copy, verify destination size/readability, then remove the source.
- If source deletion fails, keep the valid shelf copy and report "Copied; original could not
  be removed" rather than rolling back or claiming a move.
- Never remove the source represented by `loadFileRepresentation`; it may be a temporary
  provider-owned copy. Capture and validate original file URLs from the drag pasteboard.
- Do not offer Option-move for read-only volumes, iCloud placeholders that are not downloaded,
  or locations where coordination reports no write access.

Add a setting to disable move semantics entirely. Default it on only after the manual matrix
has passed with Finder, Desktop, Downloads, iCloud Drive, external volumes, and common apps.

## C8. Visible expiry and cleanup

Replace the implicit global cutoff with `expiresAt` on every item:

- New items inherit the collection override or global tray TTL.
- `nil` means pinned/keep indefinitely.
- Changing the global TTL affects new items by default; provide an explicit "Apply to existing
  unpinned items" action rather than silently changing their deadlines.
- Show "2d left," "expires today," or a small progress treatment on each tile/details view.
- Offer Extend, Keep, and Remove Now.
- Collections show the soonest expiry when any item expires within 24 hours.

Cleanup remains event-driven: launch, app activation, calendar-day change, settings mutation,
and a one-shot task scheduled for the nearest expiry while the app is running. Do not introduce
a repeating cleanup timer. File deletion and thumbnail eviction occur off-main; publish the
new model once.

If deletion fails, retain the item with a cleanup-error state and retry later. Never remove the
model first and silently strand bytes.

## C9. Screenshot candidates

Add an opt-in "Offer new screenshots in Notch" setting.

Create `ScreenshotMonitor` with these rules:

- Determine the configured screenshot directory from the macOS screenshot preference, with
  Desktop as fallback.
- Watch only that directory using a filesystem event source. No recursive home-directory scan
  and no repeating polling.
- Snapshot existing entries when monitoring starts, then react only to newly created files.
- Require an image UTI, recent creation time, and screenshot naming/metadata evidence.
- Wait until file size is stable/readable before publishing a candidate.
- Deduplicate by file resource identifier plus creation date.
- Ignore screenshots created by Notch-owned operations and candidates already dismissed.

Add `Activity.Kind.screenshotCandidate` with a short TTL and actions when expanded:

- **Add to Shelf** copies it through `TrayIngestionPipeline`.
- **Dismiss** forgets the candidate.
- **Quick Look** previews the original while it still exists.

The compact pill should show a small pixel screenshot glyph and "Screenshot ready." It must not
copy, move, or delete the original automatically. Multiple screenshots within a short burst
coalesce into "3 screenshots ready" and add as a batch.

## C10. Tray tests

Hostless tests:

- v1-to-v2 migration, corrupt entry handling, and backup behavior.
- Item/collection Codable round trips.
- Pasteboard representation priority using abstracted descriptors.
- Drop-capability agreement between AppKit and SwiftUI consumers.
- File-name sanitization, collision resolution, and rename transaction planning.
- Expiry inheritance, pinning, extension, nearest-deadline scheduling, and failed deletion.
- Move eligibility and copy-verify-delete outcomes.
- Screenshot candidate filtering, initial-snapshot suppression, stable-write debounce, and
  burst coalescing.
- Collection deletion policies and item reassignment.

Manual matrix:

- Quick Look via Space, multi-selection, removal while previewing, and display disconnect.
- Paste Finder files, screenshots, copied images, URL, rich text, and plain text.
- Drop/drag out to Finder, Mail, Messages, Safari, Notes, and AirDrop.
- Rename files and folders, including collisions and Unicode names.
- Compress one file, multiple files, and folders.
- Option-move from local, iCloud, external, read-only, and cross-volume sources.
- Relaunch during pending thumbnail/archive work and after store migration.
- Expiry at launch, while running, and after sleep/wake.
- Screenshot location changed from Desktop to a custom directory.

## C11. Tray acceptance criteria

- Existing tray data survives migration with no lost bytes or metadata.
- Every ingress path uses the same storage commit and thumbnail lifecycle.
- Quick Look never points at a dead provider-temporary URL.
- Paste is entirely user-triggered; there is no passive clipboard monitoring.
- Option-move never deletes an original until a durable destination is verified.
- Expiry is visible before deletion and pinned items never expire.
- Screenshot detection is opt-in, event-driven, deduplicated, and never auto-copies originals.
- File/archive/thumbnail work does not block the main actor.

---

# 3. Cross-track integration decisions

## Multiple displays and transient surfaces

Quick Look, share sheets, text editing, rename fields, and permission cards that accept keyboard
input all need a single key-capable host. `NotchInteractionCoordinator` owns that exclusivity.
If the active display changes during one of these interactions, defer migration until it ends
or cancel safely with explicit feedback.

## Activities and priority

Recommended compact priority within the existing activity queue:

1. Live permission request needing a response.
2. Low battery and other urgent system warnings.
3. Screenshot candidate.
4. Tray operation completion/failure.
5. Agent working/completed state.
6. Ambient media.

Do not show the same compact activity independently on all displays when follow-active is on.
In all-displays mode, data may be mirrored, but interaction always routes to the active host.

## Error presentation

Long-running or batch operations should publish one structured operation result. Expected user
errors belong in the relevant card or tray toolbar; OSLog receives identifiers and error codes,
not command contents, clipboard data, or user file paths.

## Accessibility

- Every display adjustment has a textual value and Reset action.
- Risk is communicated by text and reason, never color alone.
- Tray selection, expiry, item kind, and collection are exposed to VoiceOver.
- All hover-only actions also have keyboard and accessibility actions.
- Reduce Motion disables cross-display and activity-pop animation without changing state timing.

---

# 4. Verification and release gates

Every milestone must pass:

1. `xcodegen generate` with no unexpected project drift.
2. Main app Debug build.
3. Independent `notch-hook` build when shared agent models change.
4. Hostless logic tests with the explicit test source list updated.
5. Universal unsigned Release build.
6. Static analysis.
7. Manual smoke checks for the milestone's permission/window/file behavior.

Before declaring all three tracks complete:

- Run the full display topology matrix.
- Run destructive Option-move tests only with disposable fixtures.
- Verify agent approval fallback with Notch stopped, watching paused, and the request timed out.
- Profile idle CPU with one and multiple displays.
- Profile memory while previewing large images and holding many tray items.
- Verify no command text, paths, clipboard contents, or screenshot filenames are emitted to
  persistent logs.
- Verify a prior Notch instance is terminated before Xcode Run to avoid the known multiple-
  instance launch failure.

## Definition of done

The expansion is complete when a user can dock or undock without losing the notch; understand
and answer an agent permission request without switching context; and capture, organize,
preview, transform, share, move, and safely expire temporary content from the tray—with no
regression to idle efficiency, click-through behavior, or data safety.
