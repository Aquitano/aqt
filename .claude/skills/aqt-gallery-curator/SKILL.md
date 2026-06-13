---
name: aqt-gallery-curator
description: Import artworks and build a curated 3D gallery for the user via the aqt-gallery MCP tools. Use when the user wants to import artwork images (URLs), fill in artwork details, or assemble/publish a gallery — e.g. "import these paintings and make me a gallery", "set up a Monet room", "add details to my imported artworks".
---

# aqt-gallery curator

Drive the user's art gallery end to end through the **aqt-gallery MCP server**.
You import images, enrich each artwork's metadata, assemble a curated gallery,
theme it, and publish — all conversationally.

## Prerequisites

The `aqt-gallery` MCP server must be connected (an `import_artworks_from_urls`
tool should be available). If it isn't, tell the user to open **Connect an
agent** (`/connect`) in the app, create an access token, and add the server —
then stop. Don't try to hit the API another way.

If unsure of names/enums, read the `gallery://guide` resource first.

## Workflow

Work in this order. Confirm with the user before destructive steps and before
publishing.

1. **Import.** Collect the image URLs from the user. Call
   `import_artworks_from_urls` (max 25 per call; batch if needed). Keep the
   returned `artworkId` for every item — you need it for everything below.

2. **Enrich each artwork.** For every imported piece, call `update_artwork`
   with everything you can confidently determine from the image and any source:
   - `title`, `artist`, `artworkType` (one of: painting, photo, sculpture,
     print, object, other), `year`, `medium`, `dimensions`
   - `description` — a clear paragraph about the work
   - `story` — a short, engaging wall-label narrative for museum visitors
   - `funFacts` — a few short, surprising facts
   Then `set_artwork_tags` with relevant themes/keywords.
   - Only set fields you're reasonably sure of. Don't invent facts; if you're
     guessing, say so to the user or leave the field out.
   - `rating`/`review`/`thoughts` are the owner's *private* notes — leave them
     unless the user gives an opinion to record.

3. **Create the gallery.** `create_gallery` with a `name`, `tagline`, and
   `description`. Note the returned gallery `id`.

4. **Hang the artworks.** `add_artworks_to_gallery` with the gallery id and the
   imported `artworkId`s. This auto-publishes those artworks so they can appear
   in the 3D museum. Use `set_gallery_artworks` to reorder.

5. **Theme it.** `update_gallery` with a `theme` that fits the mood (hex
   `wallColor`/`accentWallColor`/`floorColor`, `floorRoughness` 0–1,
   `ambientIntensity` 0–5, `lightTemperature` warm|neutral|cool) and optionally
   a `coverArtworkId` (must be a member).

6. **Review, then publish.** Summarise what you built (artwork count, titles,
   theme) and show the user. Only call `publish_gallery` with `publish: true`
   once they approve — otherwise leave it as a draft.

## Tips

- Use `list_artworks` / `list_galleries` to orient if you lose track of ids.
- `update_artwork` is a partial patch: omitted fields are left untouched, an
  explicit `null` clears a field.
- Prefer one `update_artwork` call per artwork over many tiny edits.
