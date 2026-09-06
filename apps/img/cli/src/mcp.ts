import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type } from "arktype";
import { z } from "zod";

import { bookInput } from "@/domain/api";
import { PAGE_UNITS } from "@/domain/page";

import { ApiError, type Client } from "./client";
import { bookDocument, coverFrom, importPhotos } from "./ops";

/**
 * Exposes the same operations as the command line to MCP hosts over stdio.
 * Runs on the user's machine so `import_photos` can read local files; every
 * call goes to the app with the configured API key.
 */

const BOOK_SCHEMA = bookInput.toJsonSchema({ fallback: { predicate: (ctx) => ctx.base } });

const GUIDE = `# Laying out a photo book

Coordinates: every page is a ${PAGE_UNITS} x ${PAGE_UNITS} square. A spread has a "left" and a
"right" page. x/y are the top-left corner of the unrotated box, w/h its size, rotation in
degrees around the box centre. Later elements draw on top of earlier ones.

Photos: keep the photo's own aspect ratio (w / h = photo.width / photo.height, from
list_photos). Frames: "none" (flush), "polaroid" (white border, thick bottom), "corners"
(mounting corners), "tape" (a strip of tape). Mix one frame style per album, not per page.

Text: font "hand" (handwritten) or "clean" (sans). size is a page-unit font size (20-200;
40-56 reads well for captions). h is roughly size * 1.3 per line. Keep captions short.

Recipes (margins of ~80-100 units, values for a portrait/landscape photo as noted):
- Hero: one landscape photo, w 840, x 80, y 200. Caption below: x 200, y 780, w 600.
- Tall hero: one portrait photo, h 840, y 80, centred horizontally.
- Pair: two landscape photos stacked, w 700, x 150, y 90 and y 520.
- Grid: four photos, w 400 each at (80,80), (520,80), (80,520), (520,520) (crop-free if square-ish).
- Cluster: three photos w 380-420, frame "polaroid", rotations -6..6, overlapping corners slightly.

Sequencing: order photos by takenAt. Open with a hero, alternate dense and sparse spreads,
put a caption on at most one page per spread, and let the last spread breathe. Keep a page's
elements inside its own bounds; the spread's gutter is the shared edge at x = 0 (right page)
/ x = ${PAGE_UNITS} (left page).

Workflow: import_photos -> list_photos (ids, sizes, dates) -> create_album -> put_book. Re-read
with get_book before editing an existing album so you keep spread ids.`;

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const failure = (cause: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text:
        cause instanceof ApiError
          ? `${cause.message} (${cause.status})`
          : cause instanceof Error
            ? cause.message
            : String(cause),
    },
  ],
});

/** Runs a tool body and turns thrown errors into MCP error results. */
const tool =
  <TArgs, TResult>(body: (args: TArgs) => Promise<TResult>) =>
  async (args: TArgs) => {
    try {
      return text(await body(args));
    } catch (error) {
      return failure(error);
    }
  };

export async function serveMcp(client: Client) {
  const server = new McpServer({ name: "album", version: "1.0.0" });

  server.registerResource(
    "guide",
    "album://guide",
    {
      title: "Layout guide",
      description: "How to lay out spreads well",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );
  server.registerResource(
    "book-schema",
    "album://schema/book",
    {
      title: "Book JSON schema",
      description: "Schema of the document put_book accepts",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "application/json", text: JSON.stringify(BOOK_SCHEMA, null, 2) },
      ],
    }),
  );

  server.registerPrompt(
    "design_book",
    {
      title: "Design a photo book",
      description: "Lay out an album from the photos in the library",
      argsSchema: { albumId: z.string().optional(), brief: z.string().optional() },
    },
    ({ albumId, brief }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${GUIDE}\n\n${albumId ? `Work on album ${albumId}: call get_book first.` : "Create a new album with create_album."}${brief ? `\n\nBrief: ${brief}` : ""}\n\nUse list_photos for ids and aspect ratios, then write the whole book with put_book.`,
          },
        },
      ],
    }),
  );

  server.registerTool(
    "layout_guide",
    {
      title: "Layout guide",
      description:
        "Rules and recipes for laying out spreads, plus the JSON schema put_book accepts.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => `${GUIDE}\n\n## Book schema\n\n${JSON.stringify(BOOK_SCHEMA)}`),
  );

  server.registerTool(
    "list_albums",
    {
      title: "List albums",
      description: "Albums owned by the user, newest first.",
      annotations: { readOnlyHint: true },
    },
    tool(async () =>
      (await client.albums.list()).map((a) => ({
        id: a.id,
        title: a.title,
        cover: a.cover,
        shareUrl: a.shareSlug ? `${client.url}/s/${a.shareSlug}` : null,
        updatedAt: new Date(a.updatedAt).toISOString(),
      })),
    ),
  );

  server.registerTool(
    "create_album",
    {
      title: "Create album",
      description:
        "Creates an empty album. material: linen | leather | cloth. color: oxblood | forest | navy | sand | charcoal | cream, or any CSS colour.",
      inputSchema: {
        title: z.string().min(1),
        material: z.string().optional(),
        color: z.string().optional(),
      },
    },
    tool(async ({ title, material, color }) =>
      client.albums.create({ title, cover: coverFrom({ material, color }) }),
    ),
  );

  server.registerTool(
    "get_book",
    {
      title: "Get book",
      description:
        "The album as an editable document: title, cover and spreads with their elements.",
      inputSchema: { albumId: z.string() },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ albumId }) => bookDocument(await client.albums.get(albumId))),
  );

  server.registerTool(
    "put_book",
    {
      title: "Put book",
      description:
        "Replaces the whole album: optional title and cover, and every spread in order. Spread ids from get_book are kept; omit ids for new spreads. Read layout_guide first. Elements must lie on their page and reference photo ids from list_photos.",
      inputSchema: { albumId: z.string(), book: z.record(z.string(), z.unknown()) },
    },
    tool(async ({ albumId, book }) => {
      const parsed = bookInput(book);
      if (parsed instanceof type.errors) throw new Error(`Invalid book:\n${parsed.summary}`);
      const saved = await client.albums.putBook(albumId, parsed);
      return {
        albumId: saved.album.id,
        title: saved.album.title,
        spreads: saved.spreads.map((s) => ({ id: s.id, elements: s.elements.length })),
        viewUrl: `${client.url}/albums/${saved.album.id}`,
      };
    }),
  );

  server.registerTool(
    "list_photos",
    {
      title: "List photos",
      description:
        "The photo library with sizes and capture dates. Use width/height to keep aspect ratios.",
      annotations: { readOnlyHint: true },
    },
    tool(async () =>
      (await client.photos.list()).map((p) => ({
        id: p.id,
        width: p.width,
        height: p.height,
        orientation: p.width > p.height ? "landscape" : p.width < p.height ? "portrait" : "square",
        takenAt: p.takenAt ? new Date(p.takenAt).toISOString() : null,
      })),
    ),
  );

  server.registerTool(
    "import_photos",
    {
      title: "Import photos",
      description:
        "Uploads image files from this machine into the library. Paths must be absolute.",
      inputSchema: { paths: z.array(z.string()).min(1) },
    },
    tool(async ({ paths }) =>
      (await importPhotos(client, paths, () => undefined)).map((p) => ({
        id: p.id,
        file: p.file,
        width: p.width,
        height: p.height,
        takenAt: p.takenAt ? new Date(p.takenAt).toISOString() : null,
      })),
    ),
  );

  server.registerTool(
    "share_album",
    {
      title: "Share album",
      description: "Turns the public read-only link on or off.",
      inputSchema: { albumId: z.string(), enabled: z.boolean() },
    },
    tool(async ({ albumId, enabled }) => {
      if (!enabled) {
        await client.albums.unshare(albumId);
        return { enabled: false };
      }
      return { enabled: true, ...(await client.albums.share(albumId)) };
    }),
  );

  server.registerTool(
    "delete_album",
    {
      title: "Delete album",
      description: "Deletes an album and all its spreads. Photos stay in the library.",
      inputSchema: { albumId: z.string() },
      annotations: { destructiveHint: true },
    },
    tool(async ({ albumId }) => {
      await client.albums.delete(albumId);
      return { deleted: albumId };
    }),
  );

  await server.connect(new StdioServerTransport());
}
