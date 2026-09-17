import { artworkTypes } from "../api/routers/gallery-helpers";

export const SERVER_INSTRUCTIONS = `This server lets you build a user's art exhibition end to end.

An exhibition is a walkable 3D building of one or more rooms, each hanging an ordered set of artworks. A single-room exhibition is a gallery; add rooms to turn it into a museum. create_exhibition always returns a ready default room (roomId), so the one-room flow never needs add_room.

Typical flow for "import these artworks and set up a gallery":
1. import_artworks_from_urls — download remote images into the user's archive. Each item's url is required; every other field is optional metadata (same fields as update_artwork, plus tagNames and customFields) written onto the new artwork in the same call — so a JSON manifest can be imported image + details in one step, and the returned artworkId already matches the record. Items with only a url still arrive title-only. (When a piece exists in the Met, the Art Institute of Chicago, or Wikidata, import_from_museum_object does steps 1–2 in one call — it imports the image and fills title, artist, year, medium, dimensions, description and a linked artist from the source, so the real dimensions drive the 3D size. Prefer it for catalogued works.)
2. enrich_artworks — fill in everything you can infer for all the imported pieces in one batch call: title, artist, artworkType, year, medium, dimensions, description, story (a short wall-label narrative), funFacts, plus tagNames and customFields per item. (Skip this for items whose metadata you already passed to import_artworks_from_urls; update_artwork patches a single piece if you only need one.) To attribute a structured artist, use link_artist (find-or-create by name + link, even across several works at once) instead of wiring up artistId by hand.
3. create_exhibition — make the exhibition (name, tagline, description). Keep the returned roomId.
4. add_artworks_to_room — hang the imported artworks in that room. This also auto-publishes those artworks so they can appear in the 3D walk.
5. update_exhibition — set a fitting 3D theme and optionally a cover artwork. For deliberate spatial curation, set_room_placements assigns each piece a wall, an along-wall offset, and a scale; otherwise the layout is generated automatically.
6. lint_exhibition — pre-publish check; fix any errors (and ideally warnings) it reports, then publish_exhibition when the user is happy (leave as a draft otherwise).

For a larger, multi-room building, call add_room for each further room and set_room_artworks (or add_artworks_to_room) to hang art in it; add_room/update_room can size a room explicitly and reorder_rooms arranges the walk. Each room follows steps 2–6 above.

To clean up a bad import, delete_artwork (reversible with restore_artwork; purge_artwork removes it for good). set_primary_asset picks an artwork's hero image when it has several.

Read tools (list_artworks, get_artwork, list_exhibitions, list_tags, list_artists) let you orient before writing. Read gallery://guide for the full field reference and enums.`;

export const GUIDE = `# aqt-gallery agent guide

## Artwork fields (update_artwork)
Identify the work with \`artworkId\` (from list_artworks / an import). Every artwork-level tool names it the same way: get_artwork, delete_artwork, restore_artwork, purge_artwork, set_artwork_tags, set_artwork_custom_fields and enrich_artworks items.
- title: string
- artist: string — the creator's name (free text; a quick label)
- artistId: link to a structured artist entity (see Artists). Overrides the free-text artist on the public artist wall; pass null to unlink.
- artworkType: one of ${artworkTypes.join(", ")}
- year: free text (e.g. "1889", "c. 1920")
- medium: e.g. "Oil on canvas"
- dimensions: e.g. "73.7 cm × 92.1 cm"
- description: a paragraph describing the work
- story: a short, engaging wall-label narrative shown to museum visitors
- funFacts: array of short, surprising facts
- rating (0–5), review, thoughts: the owner's *private* notes (never shown publicly)
- seenAt: ISO date (YYYY-MM-DD)
- sourceUrl: where the image/info came from

Set only the fields you know — omitted fields are left untouched; passing null clears a field.

**Inline import metadata:** every field above (plus \`tagNames\` and \`customFields\`) can also be passed directly on an \`import_artworks_from_urls\` item — import image + full details in one call instead of import → enrich. The new artwork's returned \`artworkId\` is guaranteed to match the record you sent. An item with only a \`url\` still imports title-only. A metadata failure on an item purges that one artwork and reports it in the response's \`failed\` array; sibling items are unaffected.

## Importing from museums (import_from_museum_object)
For a catalogued work, import_from_museum_object is the fastest path: one call imports the image and fills title, artist, year, medium, dimensions, description and credit from the source, and links a structured artist. Sources and ids:
- met — The Metropolitan Museum of Art; objectId is the numeric Met objectID (e.g. 436524, the number in a metmuseum.org/art/collection/search/… URL).
- artic — Art Institute of Chicago; objectId is the numeric id (e.g. 27992, in an artic.edu/artworks/… URL).
- wikidata — objectId is the Q-number of the artwork entity (e.g. Q45585 for a specific painting), not the artist.
You can pass a url to the object page instead of source/objectId. The dimensions arrive as "<h> × <w> cm", which the 3D museum reads as the real canvas size. After importing, use update_artwork/enrich_artworks only to add what the source lacks (most often a story).

## Images
Local files (or images on hosts that refuse server-side fetches) go over HTTP, not a tool: POST multipart \`files\` (+ optional positional \`titles\`) to the server's /media/upload with the same bearer token, then enrich the returned artworkIds. Imported and uploaded images are stored as media assets. Read them via get_artwork: \`image\` holds the resolved thumbnail/original URLs and \`mediaAssets[]\` carries the pixel width/height. The artwork's own imageUrl / thumbnailUrl / imageWidth / imageHeight columns are populated only for externally-linked reference images and stay null for imports — rely on \`image\` / \`mediaAssets\` instead.

## Artists
An artist is a reusable entity (name, bio, birthYear, deathYear, nationality, portraitUrl) whose details render on the artist's wall in the 3D museum. The easy path: link_artist with the artist's name and the artworkIds to attribute — it reuses an existing artist of that name (yours or a built-in reference artist) or creates one, then links every listed work in a single call. Pass all works by the same creator at once. Prefer linking a structured artist over the free-text artist field when you have biographic detail. Lower-level tools remain if you need them: list_artists to browse, create_artist to make one without linking, and update_artwork.artistId (or artistId: null to unlink).

## Batch enrichment
enrich_artworks patches details, tags (tagNames), and custom fields (customFields) for up to 50 artworks in one call — prefer it over one update_artwork per piece after an import. Each item is applied independently and the result reports { artworkId, ok, error } per item.

## Tags
set_artwork_tags replaces an artwork's tags with the given names (created on demand).

## Custom fields
set_artwork_custom_fields replaces an artwork's label/value rows (e.g. "Collection" → "MoMA").

## Lifecycle
- delete_artwork soft-deletes (hidden from the archive and public exhibitions, but recoverable).
- restore_artwork undoes that; purge_artwork removes the artwork and its files permanently.
- set_primary_asset chooses which uploaded media asset is the hero image (ids come from get_artwork → mediaAssets[]).

## Exhibitions and rooms
An exhibition is a building of one or more rooms, each with its own ordered artworks. One room makes a gallery; several make a museum — the tools are the same. Exhibition-level tools (update_exhibition, publish_exhibition, delete_exhibition, lint_exhibition, add_room, reorder_rooms) take \`exhibitionId\`; room-level tools take \`roomId\`.
- create_exhibition returns { id, slug, roomId }: the default room is ready to hang into. add_room appends further rooms; reorder_rooms arranges the walk; update_room renames/resizes; delete_room removes one (its artworks stay in the archive).
- add_artworks_to_room appends (skipping duplicates); set_room_artworks replaces the room's exact ordered list. An artwork hangs in at most one room per exhibition — hanging it elsewhere moves it.
- update_exhibition sets name/tagline/description, kind (exhibition | artist_collection | collection | custom — the lobby label), the 3D theme, and a cover (the cover must be hung in one of the rooms).
- publish_exhibition controls whether the exhibition appears in the public 3D lobby.

## Curating the 3D hang
By default paintings are auto-placed along the walls in hang order. To curate exact placement:
- set_room_placements sets, per artwork: wall (north | south | east | west), wallOffset (0–1 along that wall), scale (1 = natural size), note (a private curator note). Each field is a partial patch; pass null to revert one to automatic. Only artworks already hung are affected.
- Room size: add_room / update_room accept layout { width, depth, height } in meters (roughly width 13–24, depth 12–30, height 5–8); omit or null for procedural sizing.

## Exhibition theme (update_exhibition.theme)
- wallColor, accentWallColor, floorColor: hex strings like "#1a1a1a"
- floorRoughness: 0–1
- ambientIntensity: 0–5
- lightTemperature: warm | neutral | cool

## Pre-publish validation
lint_exhibition is a read-only check to run before publishing. It returns { ok, errorCount, warningCount, infoCount, findings[] }, each finding being { level, code, message, roomId?, roomName?, artworkId?, wall? }.
- errors (ok is false): a hung work that won't render — deleted, unpublished, or removed — or an exhibition with nothing displayable.
- warnings: missing image (placeholder shown), dimensions absent or not in "<h> × <w> cm" form (3D size guessed from image aspect), missing story (empty inspect narrative), an empty room in a multi-room exhibition, and curated walls packed past capacity (paintings would overlap — spread across walls or enlarge the room with update_room/set_room_placements).
- info: works with no artist attribution.
Fix errors before publishing; warnings are quality nudges.

## Publishing
Adding an artwork to a room auto-publishes that artwork. publish_exhibition controls whether the exhibition itself is visible in the public lobby. Run lint_exhibition first.`;
