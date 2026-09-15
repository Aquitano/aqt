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

  test("import_artworks_from_urls items accept inline metadata", () => {
    const importTool = galleryTools.find((tool) => tool.name === "import_artworks_from_urls");
    if (!importTool) throw new Error("import_artworks_from_urls not generated");

    // A JSON-manifest-style item: url + arbitrary detail subset.
    const full = importTool.inputSchema.safeParse({
      items: [
        {
          url: "https://example.org/painting.jpg",
          title: "Starry Night",
          artist: "Vincent van Gogh",
          artworkType: "painting",
          year: "1889",
          story: "Painted from his asylum window.",
          funFacts: ["The swirls match wind-map data."],
          tagNames: ["post-impressionism"],
          customFields: [{ label: "Collection", value: "MoMA" }],
        },
      ],
    });
    expect(full.success).toBe(true);

    // The old bare-URL shape still validates unchanged.
    const bare = importTool.inputSchema.safeParse({
      items: [{ url: "https://example.org/painting.jpg" }],
    });
    expect(bare.success).toBe(true);

    // A non-URL string is rejected.
    const bad = importTool.inputSchema.safeParse({
      items: [{ url: "not-a-url" }],
    });
    expect(bad.success).toBe(false);
  });

  test("carry a description and an object input schema", () => {
    for (const tool of galleryTools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
    }
  });
});
