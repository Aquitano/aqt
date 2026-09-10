import { env } from "@aqt/gallery-env/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { inferRouterOutputs } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../api/context";
import { createCallerFactory } from "../api/index";
import { appRouter } from "../api/routers/index";
import { GUIDE, SERVER_INSTRUCTIONS } from "./guide";
import { galleryTools } from "./tools";

const createCaller = createCallerFactory(appRouter);

type Caller = ReturnType<typeof createCaller>;
type RouterOutputs = inferRouterOutputs<typeof appRouter>;

/** The authenticated session the tools act on behalf of. */
type Session = NonNullable<Context["session"]>;

const PUBLIC_IMAGE_BASE = env.SERVER_URL.replace(/\/+$/, "");

/**
 * Turn a relative API image path into an absolute URL the agent can actually
 * fetch with its token. The cookie-only `/media/<assetId>/…` path is swapped
 * for the equivalent `/public-image/artwork/<id>/…` form, which a PAT can reach
 * for the owner's own artworks (published or draft).
 */
function agentImageUrl(relative: string | null, artworkId: string): string | null {
  if (!relative) return null;
  const media = /^\/media\/[^/]+\/(thumb|original)$/.exec(relative);
  if (media) {
    const variant = media[1] === "thumb" ? "thumb" : "full";
    return `${PUBLIC_IMAGE_BASE}/public-image/artwork/${artworkId}/${variant}`;
  }
  return relative.startsWith("/") ? `${PUBLIC_IMAGE_BASE}${relative}` : relative;
}

/**
 * The web prefixes its own origin onto the relative image paths the procedures
 * return, so absolutising them there would double-prefix. Agents need absolute
 * URLs instead, so the rewrite lives here, keyed by procedure path.
 */
const outputTransforms = {
  "artworks.list": (rows: RouterOutputs["artworks"]["list"]) =>
    rows.map((row) => ({
      ...row,
      thumbnailUrl: agentImageUrl(row.thumbnailUrl, row.id),
      originalUrl: agentImageUrl(row.originalUrl, row.id),
    })),
  "artworks.get": (data: RouterOutputs["artworks"]["get"]) => {
    if (!data) return null;
    const id = data.artwork.id;
    return {
      ...data,
      image: data.image
        ? {
            thumbnailUrl: agentImageUrl(data.image.thumbnailUrl, id),
            originalUrl: agentImageUrl(data.image.originalUrl, id),
          }
        : null,
      mediaAssets: data.mediaAssets.map((asset) => ({
        ...asset,
        thumbnailUrl: agentImageUrl(asset.thumbnailUrl, id),
        originalUrl: agentImageUrl(asset.originalUrl, id),
      })),
    };
  },
} satisfies Record<string, (result: never) => unknown>;

function json(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Runs a tool body, turning a thrown tRPC/validation error into a readable
 * tool error result instead of crashing the JSON-RPC request. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
}

/** Resolve a dotted procedure path on the caller and invoke it. The caller is
 * a typed proxy, so walking it by string is the one place types are asserted. */
async function invoke(caller: Caller, path: string, input: unknown): Promise<unknown> {
  const procedure = path
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller) as (
    args: unknown,
  ) => Promise<unknown>;
  const result = await procedure(input);
  const transform = outputTransforms[path as keyof typeof outputTransforms];
  return transform ? (transform as (value: unknown) => unknown)(result) : result;
}

/**
 * Build an MCP server bound to one authenticated user. Every tool is generated
 * from a tRPC procedure's `mcp` meta and delegates to that procedure (via a
 * server-side caller), so there is exactly one implementation and one set of
 * ownership/permission checks behind both surfaces.
 */
export function createGalleryMcpServer(session: Session): McpServer {
  const caller = createCaller({ auth: null, session });

  const server = new McpServer(
    { name: "aqt-gallery", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of galleryTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          ...(tool.readOnly ? { readOnlyHint: true } : {}),
          ...(tool.destructive ? { destructiveHint: true } : {}),
          ...(tool.idempotent ? { idempotentHint: true } : {}),
        },
      },
      (args) => run(() => invoke(caller, tool.path, args)),
    );
  }

  server.registerResource(
    "guide",
    "gallery://guide",
    {
      title: "Exhibition agent guide",
      description:
        "Field reference, enums, theme shape, and the recommended import→enrich→curate→publish workflow.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }],
    }),
  );

  server.registerPrompt(
    "curate_gallery",
    {
      title: "Import & curate a gallery",
      description:
        "Guide the agent through importing images and assembling a full curated one-room exhibition.",
      argsSchema: {
        image_urls: z
          .string()
          .optional()
          .describe("Whitespace/newline-separated image URLs to import"),
        vibe: z
          .string()
          .optional()
          .describe("Desired mood/theme for the gallery, e.g. 'moody nocturnes'"),
      },
    },
    ({ image_urls, vibe }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Set up a curated art gallery for me.",
              image_urls
                ? `Import these images first:\n${image_urls}`
                : "Ask me for the images (URLs) to import if I haven't given them.",
              vibe ? `The gallery should feel: ${vibe}.` : "",
              "",
              "Follow the workflow in the server instructions: import the images, then for each artwork fill in title, artist, type, year, medium, description, an engaging story and a few fun facts, and relevant tags. Then create the exhibition, hang the artworks in its default room, give it a fitting 3D theme and a cover, lint it, and show me a summary before publishing. Read gallery://guide for the exact fields and enums.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
