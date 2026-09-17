# Gallery MCP server

An [MCP](https://modelcontextprotocol.io) endpoint that lets any agent (Claude
Code, Claude Desktop, Cursor, …) import artworks, fill in their details, and
build full curated exhibitions on a user's behalf — conversationally.

It is mounted on the main server at:

```
<SERVER_URL>/mcp        e.g. http://localhost:3000/mcp
```

Every tool is generated from a tRPC procedure that opts in with `mcp` meta
(`apps/server/src/mcp/tools.ts`), and is invoked through a server-side caller.
The procedure's own zod input is the tool's input schema, so there's one
implementation, one schema, and one set of ownership/permission checks behind
both surfaces.

## Authentication

Requests authenticate with a **personal access token** sent as a bearer header:

```
Authorization: Bearer aqtg_xxxxxxxx…
```

A user mints tokens in the web app under **Connect an agent** (`/connect`). The
plaintext is shown once; only its SHA-256 hash is stored. Every action the agent
takes is scoped to that user. (A browser cookie session also works, e.g. for the
MCP Inspector.)

## Connecting

**Claude Code (CLI):**

```bash
claude mcp add --transport http aqt-gallery http://localhost:3000/mcp \
  --header "Authorization: Bearer aqtg_your_token"
```

**Config-file clients** (Claude Desktop custom connectors, Cursor, …):

```json
{
  "mcpServers": {
    "aqt-gallery": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer aqtg_your_token" }
    }
  }
}
```

The transport is **stateless Streamable HTTP**: a fresh MCP server + transport
handle each request, so it scales without server-side session state.

## Tools

| Tool                        | What it does                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_artworks`             | List the user's archived artworks (find ids).                                                                                                                                                                                                                                                   |
| `get_artwork`               | One artwork with all details, custom fields, tags.                                                                                                                                                                                                                                              |
| `list_exhibitions`          | The user's exhibitions with ordered rooms, each room's ordered placements, and publish state.                                                                                                                                                                                                   |
| `list_tags`                 | The user's tags.                                                                                                                                                                                                                                                                                |
| `list_artists`              | Artists you can link — your own plus built-in reference artists.                                                                                                                                                                                                                                |
| `import_artworks_from_urls` | Download 1–25 remote images into the archive (stores each image's source URL). Each item may also carry full artwork metadata (same fields as `update_artwork`, plus `tagNames`/`customFields`), applied in the same call — so a JSON manifest of artworks imports image + details in one step. |
| `import_from_museum_object` | One-call enriched import (1–10 objects) from the Met, Art Institute of Chicago, or Wikidata: details + image + linked artist.                                                                                                                                                                   |
| `update_artwork`            | Set any subset of an artwork's details (partial patch), incl. `artistId`.                                                                                                                                                                                                                       |
| `enrich_artworks`           | Batch-patch details + tags + custom fields for up to 50 artworks; per-item ok/error.                                                                                                                                                                                                            |
| `set_artwork_tags`          | Replace an artwork's tags (created on demand).                                                                                                                                                                                                                                                  |
| `set_artwork_custom_fields` | Replace an artwork's label/value rows.                                                                                                                                                                                                                                                          |
| `set_primary_asset`         | Choose an artwork's hero image among its uploaded assets.                                                                                                                                                                                                                                       |
| `delete_artwork`            | Soft-delete (hidden from archive + exhibitions, recoverable).                                                                                                                                                                                                                                   |
| `restore_artwork`           | Undo a `delete_artwork`.                                                                                                                                                                                                                                                                        |
| `purge_artwork`             | Permanently delete an artwork and its files.                                                                                                                                                                                                                                                    |
| `create_artist`             | Create a reusable artist (bio/dates/nationality); link via `update_artwork.artistId`.                                                                                                                                                                                                           |
| `link_artist`               | Find-or-create an artist by name and link it to up to 50 artworks at once.                                                                                                                                                                                                                      |

An **exhibition** is a walkable building of one or more rooms, each with its
own ordered artworks. One room is a gallery, several are a museum — the tools
are the same. `create_exhibition` makes the first room for you and returns its
`roomId`, so a one-room flow never needs `add_room`:

| Tool                   | What it does                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `create_exhibition`    | Create a new (draft) exhibition with a default room; returns `{ id, slug, roomId }`. |
| `update_exhibition`    | Name, tagline, description, kind (lobby label), 3D theme, cover.                     |
| `lint_exhibition`      | Pre-publish validation: findings that would degrade the 3D render, per room.         |
| `publish_exhibition`   | Publish / unpublish an exhibition.                                                   |
| `delete_exhibition`    | Delete an exhibition and its rooms (member artworks are kept).                       |
| `add_room`             | Add a further room (optional explicit `layout`).                                     |
| `update_room`          | Rename a room / edit its description / set `layout` dimensions.                      |
| `delete_room`          | Delete a room (its artworks are kept).                                               |
| `reorder_rooms`        | Reorder an exhibition's rooms.                                                       |
| `add_artworks_to_room` | Append artworks to a room (auto-publishes them).                                     |
| `set_room_artworks`    | Replace/reorder a room's artworks.                                                   |
| `set_room_placements`  | Curate the 3D hang: per-artwork wall, along-wall offset, scale, note.                |

Tools that act on a single entity take the entity's own id: `id` for an
artwork (`get_artwork`, `update_artwork`, `delete_artwork`, `restore_artwork`,
`purge_artwork`) or an exhibition (`update_exhibition`, `publish_exhibition`,
`delete_exhibition`, `lint_exhibition`), and `roomId` for a room.

Also exposed:

- **Resource** `gallery://guide` — the field reference, enums, and theme shape.
- **Prompt** `curate_gallery` — kicks off the import→enrich→curate→publish flow.

### Uploading local files

Images that live on the agent's machine (or on a host that refuses server-side
fetches) go over plain HTTP instead of a tool, since MCP inputs are JSON and
can't carry bytes efficiently. `POST /media/upload` accepts the same bearer
token and runs the same ingest as a URL import; enrich the returned artwork
ids over MCP afterwards.

```bash
curl http://localhost:3000/media/upload \
  --header "Authorization: Bearer aqtg_your_token" \
  --form "files=@hermes.jpg" --form "titles=Bronze Statuette of Hermes" \
  --form "files=@kantei.jpg" --form "titles=Landscape with Pine Tree"
# → { "uploaded": [{ "artworkId": "…", "title": "…", "asset": { … } }, …] }
```

Up to 25 files of 25 MB each per request, but keep one request under ~100 MB
in total (Bun's default body limit is 128 MB); `titles` pairs with `files` by
position and is optional.

## Recommended workflow

1. `import_artworks_from_urls` — note the returned `artworkId`s. Each item
   may carry its full metadata (title, artist, year, story, tags, …) alongside
   the `url`, in which case step 2 is already done for that piece.
2. `enrich_artworks` — batch in title, artist, type, year, medium, dimensions,
   description, a short `story`, `funFacts`, tags, and custom fields for every
   imported piece at once (or `update_artwork` for a single one).
3. `create_exhibition` — name + tagline + description; keep the `roomId`.
4. `add_artworks_to_room` — hang them in that room (this auto-publishes the
   artworks).
5. `update_exhibition` — a fitting 3D theme + a cover; `set_room_placements`
   to curate the exact 3D hang.
6. `lint_exhibition`, then `publish_exhibition` — when the user is happy.

For a multi-room building, call `add_room` per further room and hang each one
with `add_artworks_to_room` / `set_room_artworks`; `reorder_rooms` arranges
the walk.
