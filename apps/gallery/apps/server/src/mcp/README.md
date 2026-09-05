# Gallery MCP server

An [MCP](https://modelcontextprotocol.io) endpoint that lets any agent (Claude
Code, Claude Desktop, Cursor, …) import artworks, fill in their details, and
build full curated galleries on a user's behalf — conversationally.

It is mounted on the main server at:

```
<SERVER_URL>/mcp        e.g. http://localhost:3000/mcp
```

The endpoint reuses the exact same tRPC procedures the web app calls (via a
server-side caller), so there's one implementation and one set of
ownership/permission checks behind both surfaces.

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

| Tool                        | What it does                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `list_artworks`             | List the user's archived artworks (find ids).                                         |
| `get_artwork`               | One artwork with all details, custom fields, tags.                                    |
| `list_galleries`            | The user's galleries with ordered members + publish state.                            |
| `list_museums`              | The user's multi-room museums with each room's ordered members.                       |
| `list_tags`                 | The user's tags.                                                                      |
| `list_artists`              | Artists you can link — your own plus built-in reference artists.                      |
| `import_artworks_from_urls` | Download 1–25 remote images into the archive.                                         |
| `update_artwork`            | Set any subset of an artwork's details (partial patch), incl. `artistId`.             |
| `set_artwork_tags`          | Replace an artwork's tags (created on demand).                                        |
| `set_artwork_custom_fields` | Replace an artwork's label/value rows.                                                |
| `create_artist`             | Create a reusable artist (bio/dates/nationality); link via `update_artwork.artistId`. |
| `create_gallery`            | Create a new (draft) curated gallery.                                                 |
| `add_artworks_to_gallery`   | Append artworks (auto-publishes them).                                                |
| `set_gallery_artworks`      | Replace/reorder a gallery's full membership.                                          |
| `update_gallery`            | Name, tagline, description, 3D theme, cover.                                          |
| `publish_gallery`           | Publish / unpublish a gallery.                                                        |
| `delete_gallery`            | Delete a gallery (member artworks are kept).                                          |

A **gallery** is a single curated room. A **museum** is a building of several
rooms, each with its own ordered artworks:

| Tool                   | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `create_museum`        | Create a new (draft) multi-room museum.                   |
| `update_museum`        | Name, tagline, description, 3D theme, cover.              |
| `publish_museum`       | Publish / unpublish a museum.                             |
| `delete_museum`        | Delete a museum and its rooms (member artworks are kept). |
| `add_room`             | Add a room to a museum.                                   |
| `update_room`          | Rename a room / edit its description.                     |
| `delete_room`          | Delete a room (its artworks are kept).                    |
| `reorder_rooms`        | Reorder a museum's rooms.                                 |
| `add_artworks_to_room` | Append artworks to a room (auto-publishes them).          |
| `set_room_artworks`    | Replace/reorder a room's artworks.                        |

Also exposed:

- **Resource** `gallery://guide` — the field reference, enums, and theme shape.
- **Prompt** `curate_gallery` — kicks off the import→enrich→curate→publish flow.

## Recommended workflow

1. `import_artworks_from_urls` — note the returned `artworkId`s.
2. `update_artwork` for each — title, artist, type, year, medium, dimensions,
   description, a short `story`, and `funFacts`; `set_artwork_tags` for themes.
3. `create_gallery` — name + tagline + description.
4. `add_artworks_to_gallery` — hang them (this auto-publishes the artworks).
5. `update_gallery` — a fitting 3D theme + a cover.
6. `publish_gallery` — when the user is happy.

For a multi-room **museum**, swap steps 3–6: `create_museum`, then `add_room`
per room and `add_artworks_to_room` / `set_room_artworks` to hang each one,
`update_museum` for the theme + cover, and `publish_museum` to finish.
