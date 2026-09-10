import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { galleryTools } from "./tools";

const TOOL_NAMES = [
  "list_artworks",
  "get_artwork",
  "list_exhibitions",
  "list_tags",
  "list_artists",
  "import_artworks_from_urls",
  "import_from_museum_object",
  "update_artwork",
  "enrich_artworks",
  "set_artwork_tags",
  "set_artwork_custom_fields",
  "create_artist",
  "link_artist",
  "set_primary_asset",
  "delete_artwork",
  "restore_artwork",
  "purge_artwork",
  "create_exhibition",
  "update_exhibition",
  "publish_exhibition",
  "delete_exhibition",
  "lint_exhibition",
  "add_room",
  "update_room",
  "delete_room",
  "reorder_rooms",
  "add_artworks_to_room",
  "set_room_artworks",
  "set_room_placements",
];

describe("generated MCP tools", () => {
  test("expose exactly the opted-in procedures", () => {
    expect(galleryTools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("never expose token management", () => {
    expect(galleryTools.filter((tool) => tool.path.startsWith("apiTokens."))).toEqual([]);
  });

  test("carry a description and an object input schema", () => {
    for (const tool of galleryTools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
    }
  });
});
