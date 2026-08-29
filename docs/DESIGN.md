# Album — design spec

A web app for building photo albums that feel like physical ones: a cover you open, two-page spreads you flip through by dragging a page corner, photos you place by hand. Modern shadcn chrome around a tactile book.

Decisions below were settled in the initial interview. Anything not listed here is a routine call for the implementer.

## Scope

**v1**
- Accounts (Clerk). Albums are owned by one user.
- Album shelf, create/rename/delete albums, choose cover material and color.
- Book view: cover + N spreads + back cover, 3D page turn with drag, click and keyboard.
- Edit mode on the same book: freeform photos (move, resize, rotate, z-order), text captions, per-photo frame styles.
- Photo upload (client-side resize, streamed to R2 through the Worker), photo library per user.
- Autosave with undo/redo.
- Read-only share links (`/s/:slug`), no auth required to view.
- Desktop + tablet: full editor. Phone: single-page flip-through, no editing.

**Out of v1**: stickers/decorations, PDF/print export, collaboration, per-album page formats (pages are always square).

## Stack

| Concern | Choice |
|---|---|
| Runtime / package manager | bun |
| Framework | TanStack Start (React 19, Vite), deployed as one Cloudflare Worker |
| Styling | Tailwind v4 + shadcn/ui (radix, `new-york`, neutral base) |
| Auth | Clerk (`@clerk/tanstack-react-start`) |
| Database | Cloudflare D1 + Drizzle ORM, migrations via drizzle-kit + wrangler |
| Photo storage | Cloudflare R2, accessed through the Worker binding behind a `Storage` interface |
| Client state | Zustand (+ `zundo` for undo history), TanStack Query for server data |
| Animation | `motion` (Framer Motion) |
| Validation | ArkType, one schema per element kind, shared between client and server |
| Toasts | sonner |

Uploads are intentionally routed through the Worker (`PUT /api/photos/:id`) and streamed to the R2 binding. No S3 credentials, no presign logic. The `Storage` interface is the seam for moving to presigned URLs or Cloudflare Images later.

## Domain model

Coordinate system: every page is a **1000 x 1000 unit** square. Element geometry is stored in page units and scaled to pixels at render time. This keeps layouts independent of screen size and makes the math integer-friendly.

```ts
type Page = 'left' | 'right'

type PhotoFrame = 'none' | 'polaroid' | 'corners' | 'tape'

type ElementBase = {
  id: string
  page: Page
  x: number      // page units, top-left of the unrotated box
  y: number
  w: number
  h: number
  rotation: number // degrees, around the box center
}

type PhotoElement = ElementBase & {
  kind: 'photo'
  photoId: string
  frame: PhotoFrame
}

type TextElement = ElementBase & {
  kind: 'text'
  text: string
  font: 'hand' | 'clean'   // Caveat / Inter
  size: number             // page units (font-size), scales with page
  color: string            // oklch or hex
  align: 'left' | 'center' | 'right'
}

type Element = PhotoElement | TextElement
```

Z-order is the array order of `Spread.elements` (last = topmost). No separate `z` field.

### Tables (D1, Drizzle)

```
albums
  id            text pk   (nanoid)
  owner_id      text      (Clerk user id) idx
  title         text
  cover         json      { material: 'linen' | 'leather' | 'cloth', color: string }
  share_slug    text      nullable, unique  (present = link sharing enabled)
  created_at    integer   (unix ms)
  updated_at    integer

spreads
  id            text pk
  album_id      text fk -> albums.id (cascade) idx
  position      integer   (0-based; reorder rewrites positions for the album in one batch)
  elements      json      Element[]  (validated with ArkType on write)
  updated_at    integer

photos
  id            text pk
  owner_id      text idx
  key           text      R2 key of display image  (photos/{ownerId}/{id}.jpg, max 2500px)
  thumb_key     text      R2 key of thumbnail       (photos/{ownerId}/{id}.thumb.jpg, max 400px)
  width         integer   display image px
  height        integer
  created_at    integer
```

Elements live as a JSON column on the spread rather than as rows. One user edits one spread at a time; a spread is the natural unit of save, undo and rendering. Cross-element queries are never needed.

Deleting a photo that is referenced by an element is refused (409) until it is removed from every spread. Server checks with a `LIKE '%"photoId":"<id>"%'` on `spreads.elements` scoped to the owner. Good enough at this scale.

## Routes

| Route | Purpose |
|---|---|
| `/` | Signed out: minimal landing with sign-in. Signed in: redirect to `/albums`. |
| `/albums` | Shelf. Grid of album covers rendered with the real cover component. Create album dialog. |
| `/albums/$albumId` | The book. View mode by default, `E` or toolbar toggles edit mode. |
| `/s/$slug` | Public read-only book. Same `Book` component, no editor, no Clerk. |
| `/api/photos/$id` | `PUT` streams body to R2 (auth required). `GET` serves from R2 with long cache headers. `?thumb=1` for the thumbnail. |

Server functions (TanStack `createServerFn`), all auth-guarded except share reads:

- `albums.list`, `albums.create`, `albums.update` (title, cover), `albums.delete`
- `albums.get(albumId)` returns album + spreads ordered by position
- `albums.getShared(slug)` same shape, no auth
- `share.enable(albumId)` -> slug, `share.disable(albumId)`
- `spreads.insert(albumId, afterPosition)`, `spreads.delete`, `spreads.reorder(albumId, orderedIds)`
- `spreads.saveElements(spreadId, elements)` (the autosave target)
- `photos.create({ width, height })` -> `{ id, key, thumbKey }` then client `PUT`s both files
- `photos.list`, `photos.delete`

## The book

`src/book/` is a self-contained module that renders an album and handles turning. It knows nothing about editing except that it accepts a `renderPage(spread, page)` slot and a `locked` flag.

### Structure

```
<Book>                      perspective container, centers the open book on the spine
  <Cover side="front"/>     thick leaf with material texture
  <Leaf key=i .../>         one per spread, each leaf = right page of spread i (front face)
                            + left page of spread i+1 (back face)
  <Cover side="back"/>
```

A book with N spreads has N+1 leaves plus two covers. Leaf `i` is rotated `-180deg` when the reader is past it and `0deg` when it is still to the right. Only the current leaf, its neighbors, and the covers are mounted; the rest render as nothing. The stack of turned leaves on the left and unturned leaves on the right are drawn as thin edge stripes (a few 1px gradient lines) so the book has visible thickness.

### Turn mechanics

- Each leaf is a `motion.div` with `transform-style: preserve-3d`, `transform-origin: left center`, faces with `backface-visibility: hidden`.
- `progress` is a MotionValue in `[0, 1]`. `rotateY = -180 * progress`.
- Drag starts on the outer 15% of a page or its corner (pointer capture on the page, not on a tiny hotspot). `progress = clamp((startX - x) / pageWidth)`. Release: if `progress > 0.5` or velocity past threshold, spring to 1, otherwise spring back to 0. Spring: `stiffness 120, damping 20, mass 0.8`.
- Click on the right page edge / ArrowRight = animate forward. Left edge / ArrowLeft = backward. Home/End jump.
- The turning leaf gets a moving highlight-to-shadow gradient across its face keyed to `progress` (a real page catches light near the fold as it lifts). The pages underneath get a soft shadow with `opacity = sin(progress * PI) * 0.35` falling from the spine.
- Opening the front cover translates the whole book so the spine ends up centered (closed book is centered on its own center). Same in reverse for closing.
- Content on the back face of a leaf is mirrored by the 3D transform; it is rendered with `rotateY(180deg)` applied so it reads correctly.
- Reduced motion: page turns become a 200ms crossfade.

### Phone mode (`< 768px`)

Single-page layout: page width = viewport width minus padding, turning uses the same `Leaf` but the transform origin is the page edge and the "next" face is the next page (left or right), not the next spread. View only.

### Page rendering

`<PageSurface>` draws the paper: warm off-white, subtle grain (inline SVG `feTurbulence` at ~4% opacity), gutter gradient toward the spine, and a hairline inner edge. Elements render inside a `position: relative` box that is the page; each element is `position: absolute` with `left/top/width/height` computed from page units times `scale`, and `transform: rotate(deg)`.

`<PhotoView>` draws the photo with its frame:
- `none`: 1px inset shadow, slight lift.
- `polaroid`: white matte, 5% padding on top/sides, 14% bottom, soft drop shadow.
- `corners`: four black photo-corner triangles overlaid on the corners.
- `tape`: two translucent off-white strips, rotated ±6deg, on the top-left and top-right corners.

`<TextView>` renders the caption in the chosen font. `size` is in page units.

## The editor

`src/editor/` wraps the book in edit mode. The book is `locked` (no turning by drag; arrows still work), the current spread is what you edit.

### Store

One Zustand store per open album:

```ts
type EditorState = {
  album: Album
  spreads: Spread[]
  current: number                 // spread index, -1 = front cover, spreads.length = back cover
  mode: 'view' | 'edit'
  selection: string | null        // element id
  // actions
  setCurrent, setMode, select
  updateElement(spreadId, id, patch)
  addElement(spreadId, element)
  removeElement(spreadId, id)
  reorderElement(spreadId, id, 'forward' | 'backward' | 'front' | 'back')
  insertSpread(after), removeSpread(id), reorderSpreads(ids)
}
```

Wrapped in `zundo` `temporal` middleware tracking only `spreads`. Undo/redo = `Cmd-Z` / `Shift-Cmd-Z`. Drags produce one history entry per gesture (pause tracking on pointer down, resume on pointer up).

### Autosave

A store subscriber diffs `spreads[i].elements` by reference, debounces 800ms per spread, and calls `spreads.saveElements`. Save state is shown as a tiny status dot in the toolbar (`saved` / `saving` / `error` with retry). Structural changes (insert/reorder/delete spread) save immediately.

### Transform handles

Own implementation with pointer events and `setPointerCapture`, no library:
- Body drag: move. Shift: axis lock.
- Four corner handles: resize around the opposite corner. Photos are aspect-locked; text resizes width only and re-flows.
- One rotate handle above the top edge. Shift: snap to 15deg.
- Everything computed in page units by dividing pointer deltas by `scale`, so the same code works at any zoom.
- Snapping to page center lines and page edges within 8px, showing a hairline guide. Nothing else.
- Keyboard: arrow keys nudge 5 units (Shift: 25), Delete removes, `Cmd-]` / `Cmd-[` change z-order, Esc deselects.
- Double-click a text element to edit inline (`contentEditable` on the same node, so it is WYSIWYG).

### Toolbar

A floating shadcn `Card` docked at the bottom, always visible in edit mode:
- Add photo (opens the photo library `Sheet`: upload dropzone + grid of thumbnails; click or drag onto a page)
- Add text
- Selected-element controls: frame `ToggleGroup` for photos; font `ToggleGroup`, size `Slider`, color swatches, align for text; z-order buttons; delete
- Spread controls: insert spread after, delete spread
- Save status, undo/redo, Done

A filmstrip `Sheet` on the left shows all spreads as thumbnails (rendered at small scale by the same `PageSurface`) with drag-to-reorder.

### Uploads

`src/lib/image.ts` takes a `File`, decodes it via `createImageBitmap`, draws to an `OffscreenCanvas` at max 2500px and again at max 400px, exports JPEG q=0.86. Then `photos.create` -> two `PUT`s in parallel -> query invalidation. HEIC is not handled in v1 (Safari decodes it natively; other browsers get a toast).

## Visual system

shadcn defaults carry the chrome. The book is the only place with material rendering. Both light and dark chrome are supported; paper stays paper in dark mode (the desk gets darker, the page does not).

**Chrome**: neutral base, `--radius: 0.625rem`, no custom colors beyond shadcn tokens. Keep the chrome quiet: one accent, thin borders, generous whitespace. The shelf uses `Card`s that contain the real `Cover` component, hover lifts it 4px with a longer shadow.

**Desk**: `bg-background` with a large, faint radial gradient behind the book (`from-foreground/[0.04]` at the center to transparent) so the book sits in a pool of light.

**Paper**: `oklch(0.985 0.006 85)`, grain via `feTurbulence baseFrequency=0.9` at 4% opacity, gutter: linear gradient from `black/0.12` at the spine to transparent over 6% of the page width.

**Cover materials** (each = base color from the album's `cover.color` + a texture + edge treatment):
- `linen`: cross-hatch texture (two low-opacity repeating linear gradients at 0/90deg), matte, slight color desaturation.
- `leather`: turbulence grain at higher contrast, a 1px lighter inner rim, subtle vignette.
- `cloth`: fine diagonal weave, softer edges.
Cover color palette (six swatches): oxblood, forest, navy, sand, charcoal, cream.

**Shadows**, layered, never a single box-shadow:
`0 1px 2px rgb(0 0 0 / .08), 0 8px 24px rgb(0 0 0 / .12), 0 32px 64px -16px rgb(0 0 0 / .28)`.

**Typography**: UI uses the shadcn default stack. Captions: `Caveat` (hand) and `Inter` (clean), loaded from Google Fonts, `font-display: swap`.

**Motion**: springs everywhere, no eased durations except the reduced-motion fallback. Turn spring as above. Shelf hover: `stiffness 300, damping 24`. Selection handles appear with a 120ms fade, no scale.

## Project layout

```
src/
  routes/                TanStack Start file routes (+ api/photos.$id.ts)
  server/
    db/schema.ts         Drizzle schema
    db/client.ts         D1 binding -> drizzle
    storage.ts           Storage interface + R2 implementation
    auth.ts              getAuth helper (Clerk) + requireUser
    fns/                 createServerFn groups: albums.ts, spreads.ts, photos.ts, share.ts
  domain/
    element.ts           ArkType schemas + inferred types for Element, Cover
    page.ts              PAGE_UNITS = 1000, helpers
  book/
    Book.tsx, Leaf.tsx, Cover.tsx, PageSurface.tsx, PhotoView.tsx, TextView.tsx
    useTurn.ts           progress MotionValue, drag + spring logic
  editor/
    Editor.tsx           book in edit mode + toolbar + sheets
    store.ts             Zustand + zundo
    autosave.ts
    TransformBox.tsx     handles
    Toolbar.tsx, PhotoLibrary.tsx, Filmstrip.tsx
  components/ui/         shadcn
  lib/
    image.ts             client-side resize
    utils.ts             cn
drizzle/                 migrations
wrangler.jsonc
drizzle.config.ts
```

## Non-goals and guardrails

- No `any`. Types flow from the Drizzle schema and the ArkType element schemas; nothing is redeclared by hand.
- No canvas/WebGL for pages. Photos stay `<img>` elements so they are crisp and selectable.
- No image processing in the Worker.
- No custom z-index stacking outside the book module.
