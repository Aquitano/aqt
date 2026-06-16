import { env } from "@aqt-gallery/env/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Context } from "../api/context";
import { createCallerFactory } from "../api/index";
import { artworkTypes } from "../api/routers/gallery-helpers";
import { appRouter } from "../api/routers/index";

const createCaller = createCallerFactory(appRouter);

/** The authenticated session the tools act on behalf of. */
type Session = NonNullable<Context["session"]>;

const SERVER_INSTRUCTIONS = `This server lets you build a user's art gallery end to end.

Typical flow for "import these artworks and set up a gallery":
1. import_artworks_from_urls — download remote images into the user's archive. Each becomes a new artwork (unpublished, title only). Note the returned artworkId for every item.
2. update_artwork — for each imported piece, fill in everything you can infer: title, artist, artworkType, year, medium, dimensions, description, story (a short wall-label narrative) and funFacts. Use set_artwork_tags for themes/keywords. When you have biographic detail, optionally link a structured artist (create_artist → update_artwork.artistId; list_artists first to reuse one).
3. create_gallery — make the curated room (name, tagline, description).
4. add_artworks_to_gallery — hang the imported artworks. This also auto-publishes those artworks so they can appear in the 3D museum.
5. update_gallery — set a fitting 3D theme and optionally a cover artwork.
6. publish_gallery — publish when the user is happy (leave as a draft otherwise).

A "gallery" (create_gallery) is a single curated room. For a larger, multi-room building, use create_museum, then add_room for each room and set_room_artworks (or add_artworks_to_room) to hang art in it; update_museum sets the theme/cover and publish_museum makes it public. The per-room flow mirrors steps 2–6 above.

Read tools (list_artworks, get_artwork, list_galleries, list_museums, list_tags, list_artists) let you orient before writing. Read gallery://guide for the full field reference and enums.`;

const GUIDE = `# aqt-gallery agent guide

## Artwork fields (update_artwork)
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

## Artists
An artist is a reusable entity (name, bio, birthYear, deathYear, nationality, portraitUrl) whose details render on the artist's wall in the 3D museum. To link one: list_artists to find or reuse an existing artist (your own plus built-in reference artists), else create_artist, then set update_artwork.artistId to its id. Prefer linking a structured artist over free text when you have biographic detail; reuse one artist across all works by the same creator instead of creating duplicates.

## Tags
set_artwork_tags replaces an artwork's tags with the given names (created on demand).

## Custom fields
set_artwork_custom_fields replaces an artwork's label/value rows (e.g. "Collection" → "MoMA").

## Gallery theme (update_gallery.theme)
- wallColor, accentWallColor, floorColor: hex strings like "#1a1a1a"
- floorRoughness: 0–1
- ambientIntensity: 0–5
- lightTemperature: warm | neutral | cool

## Museums (multi-room)
A gallery is one room; a museum is a building of several rooms, each with its own ordered artworks.
- create_museum → add_room (one per room) → set_room_artworks or add_artworks_to_room to hang art in each room.
- update_museum sets name/tagline/description, the 3D theme, and a cover (the cover must be hung in one of the museum's rooms). reorder_rooms arranges the rooms.
- publish_museum controls whether the museum appears in the public 3D lobby.

## Publishing
Adding an artwork to a gallery or a museum room auto-publishes that artwork. publish_gallery / publish_museum control whether the gallery or museum itself is visible in the public museum.`;

const PUBLIC_IMAGE_BASE = env.SERVER_URL.replace(/\/+$/, "");

/**
 * Turn a relative API image path into an absolute URL the agent can actually
 * fetch with its token. The cookie-only `/media/<assetId>/…` path is swapped
 * for the equivalent `/public-image/artwork/<id>/…` form, which a PAT can reach
 * for the owner's own artworks (published or draft).
 */
function agentImageUrl(
	relative: string | null,
	artworkId: string,
): string | null {
	if (!relative) return null;
	const media = /^\/media\/[^/]+\/(thumb|original)$/.exec(relative);
	if (media) {
		const variant = media[1] === "thumb" ? "thumb" : "full";
		return `${PUBLIC_IMAGE_BASE}/public-image/artwork/${artworkId}/${variant}`;
	}
	return relative.startsWith("/")
		? `${PUBLIC_IMAGE_BASE}${relative}`
		: relative;
}

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

const themeShape = {
	wallColor: z.string().optional(),
	accentWallColor: z.string().optional(),
	floorColor: z.string().optional(),
	floorRoughness: z.number().min(0).max(1).optional(),
	ambientIntensity: z.number().min(0).max(5).optional(),
	lightTemperature: z.enum(["warm", "neutral", "cool"]).optional(),
};

/**
 * Build an MCP server bound to one authenticated user. Every tool delegates to
 * the same tRPC procedures the HTTP API exposes (via a server-side caller), so
 * there is exactly one implementation and one set of ownership/permission
 * checks behind both surfaces.
 */
export function createGalleryMcpServer(session: Session): McpServer {
	const caller = createCaller({ auth: null, session });

	const server = new McpServer(
		{ name: "aqt-gallery", version: "1.0.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	// ── Orientation (read-only) ──────────────────────────────────────────────
	server.registerTool(
		"list_artworks",
		{
			title: "List artworks",
			description:
				"List the user's archived artworks (newest first by default). Use to find artworkIds before editing or hanging them.",
			inputSchema: {
				query: z.string().optional(),
				artworkType: z.enum(artworkTypes).optional(),
				sort: z.enum(["newest", "oldest", "title", "rating"]).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async (args) =>
			run(async () => {
				const rows = await caller.artworks.list(args);
				return rows.map((row) => ({
					...row,
					thumbnailUrl: agentImageUrl(row.thumbnailUrl, row.id),
					originalUrl: agentImageUrl(row.originalUrl, row.id),
				}));
			}),
	);

	server.registerTool(
		"get_artwork",
		{
			title: "Get artwork",
			description:
				"Fetch one artwork with all its details, custom fields and tags.",
			inputSchema: { artworkId: z.string().min(1) },
			annotations: { readOnlyHint: true },
		},
		async ({ artworkId }) =>
			run(async () => {
				const data = await caller.artworks.get({ id: artworkId });
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
			}),
	);

	server.registerTool(
		"list_galleries",
		{
			title: "List galleries",
			description:
				"List the user's curated galleries (including drafts), with their ordered artworkIds and publish state.",
			annotations: { readOnlyHint: true },
		},
		async () => run(() => caller.museum.myGroups()),
	);

	server.registerTool(
		"list_tags",
		{
			title: "List tags",
			description: "List the tags the user has defined.",
			annotations: { readOnlyHint: true },
		},
		async () => run(() => caller.tags.list()),
	);

	server.registerTool(
		"list_artists",
		{
			title: "List artists",
			description:
				"List artists you can link to a work — your own plus built-in reference artists. Use to reuse an existing artistId instead of creating duplicates.",
			annotations: { readOnlyHint: true },
		},
		async () => run(() => caller.artists.list()),
	);

	// ── Import ────────────────────────────────────────────────────────────────
	server.registerTool(
		"import_artworks_from_urls",
		{
			title: "Import artworks from URLs",
			description:
				"Download remote image URLs into the user's archive (1–25 at a time). Each image is fetched once and stored locally, becoming a new unpublished artwork. Returns the new artworkId + title for each. Follow up with update_artwork to fill in details.",
			inputSchema: {
				items: z
					.array(
						z.object({
							url: z.string().url(),
							title: z.string().min(1).max(200).optional(),
						}),
					)
					.min(1)
					.max(25),
			},
		},
		async ({ items }) => run(() => caller.artworks.importFromUrl({ items })),
	);

	// ── Detail enrichment ──────────────────────────────────────────────────────
	server.registerTool(
		"update_artwork",
		{
			title: "Update artwork details",
			description:
				"Set any subset of an artwork's details. Omitted fields are left untouched; an explicit null clears a field. See gallery://guide for the field reference and the artworkType enum.",
			inputSchema: {
				artworkId: z.string().min(1),
				title: z.string().min(1).optional(),
				artist: z.string().nullable().optional(),
				artistId: z.string().nullable().optional(),
				artworkType: z.enum(artworkTypes).optional(),
				year: z.string().nullable().optional(),
				medium: z.string().nullable().optional(),
				dimensions: z.string().nullable().optional(),
				description: z.string().nullable().optional(),
				story: z.string().nullable().optional(),
				funFacts: z.array(z.string()).nullable().optional(),
				rating: z.number().int().min(0).max(5).nullable().optional(),
				review: z.string().nullable().optional(),
				thoughts: z.string().nullable().optional(),
				seenAt: z.string().nullable().optional(),
				sourceUrl: z.string().nullable().optional(),
			},
			annotations: { idempotentHint: true },
		},
		async ({ artworkId, ...fields }) =>
			run(() => caller.artworks.update({ id: artworkId, ...fields })),
	);

	server.registerTool(
		"set_artwork_tags",
		{
			title: "Set artwork tags",
			description:
				"Replace an artwork's tags with the given names (created on demand). Pass an empty array to clear all tags.",
			inputSchema: {
				artworkId: z.string().min(1),
				tagNames: z.array(z.string().min(1)),
			},
		},
		async ({ artworkId, tagNames }) =>
			run(() => caller.tags.setArtworkTags({ artworkId, tagNames })),
	);

	server.registerTool(
		"set_artwork_custom_fields",
		{
			title: "Set artwork custom fields",
			description:
				"Replace an artwork's custom label/value rows (e.g. Collection → MoMA). Order follows the array. Pass an empty array to clear them.",
			inputSchema: {
				artworkId: z.string().min(1),
				fields: z.array(
					z.object({ label: z.string().min(1), value: z.string() }),
				),
			},
		},
		async ({ artworkId, fields }) =>
			run(() =>
				caller.artworks.setCustomFields({
					artworkId,
					fields: fields.map((field, position) => ({ ...field, position })),
				}),
			),
	);

	server.registerTool(
		"create_artist",
		{
			title: "Create artist",
			description:
				"Create a reusable artist (name + optional bio, dates, nationality, portrait). Returns the new artist incl. id — pass that id to update_artwork.artistId to link works. Check list_artists first to reuse one instead of duplicating.",
			inputSchema: {
				name: z.string().min(1).max(160),
				bio: z.string().nullable().optional(),
				birthYear: z.number().int().nullable().optional(),
				deathYear: z.number().int().nullable().optional(),
				nationality: z.string().nullable().optional(),
				portraitUrl: z.string().url().nullable().optional(),
			},
		},
		async (input) => run(() => caller.artists.create(input)),
	);

	// ── Gallery setup ────────────────────────────────────────────────────────
	server.registerTool(
		"create_gallery",
		{
			title: "Create gallery",
			description:
				"Create a new (unpublished) curated gallery owned by the user. Returns the new gallery, including its id — use that id to add artworks and configure it.",
			inputSchema: {
				name: z.string().min(1).max(120),
				tagline: z.string().max(200).optional(),
				description: z.string().max(2000).optional(),
			},
		},
		async ({ name, tagline, description }) =>
			run(() =>
				caller.museum.createGroup({
					name,
					tagline: tagline ?? null,
					description: description ?? null,
				}),
			),
	);

	server.registerTool(
		"add_artworks_to_gallery",
		{
			title: "Add artworks to gallery",
			description:
				"Append artworks (by id) to a gallery, keeping the existing order and skipping duplicates. This auto-publishes the added artworks so they can appear in the 3D museum.",
			inputSchema: {
				galleryId: z.string().min(1),
				artworkIds: z.array(z.string().min(1)).min(1),
			},
		},
		async ({ galleryId, artworkIds }) =>
			run(async () => {
				const groups = await caller.museum.myGroups();
				const group = groups.find((g) => g.id === galleryId);
				if (!group) throw new Error("Gallery not found");
				const current = group.artworkIds;
				const merged = [
					...current,
					...artworkIds.filter((id) => !current.includes(id)),
				];
				return caller.museum.setGroupArtworks({
					groupId: galleryId,
					artworkIds: merged,
				});
			}),
	);

	server.registerTool(
		"set_gallery_artworks",
		{
			title: "Set / reorder gallery artworks",
			description:
				"Replace a gallery's full membership with this exact ordered list (use to reorder or remove). Own artworks are auto-published.",
			inputSchema: {
				galleryId: z.string().min(1),
				artworkIds: z.array(z.string().min(1)).max(200),
			},
			annotations: { idempotentHint: true },
		},
		async ({ galleryId, artworkIds }) =>
			run(() =>
				caller.museum.setGroupArtworks({ groupId: galleryId, artworkIds }),
			),
	);

	server.registerTool(
		"update_gallery",
		{
			title: "Update gallery",
			description:
				"Update a gallery's name, tagline, description, 3D theme, and/or cover artwork. The cover must already be a member of the gallery. See gallery://guide for theme fields.",
			inputSchema: {
				galleryId: z.string().min(1),
				name: z.string().min(1).max(120).optional(),
				tagline: z.string().max(200).nullable().optional(),
				description: z.string().max(2000).nullable().optional(),
				theme: z.object(themeShape).nullable().optional(),
				coverArtworkId: z.string().min(1).nullable().optional(),
			},
			annotations: { idempotentHint: true },
		},
		async ({ galleryId, ...fields }) =>
			run(() => caller.museum.updateGroup({ id: galleryId, ...fields })),
	);

	server.registerTool(
		"publish_gallery",
		{
			title: "Publish / unpublish gallery",
			description:
				"Set whether a gallery is publicly visible in the 3D museum. Publish only when the user is happy with it.",
			inputSchema: {
				galleryId: z.string().min(1),
				publish: z.boolean(),
			},
			annotations: { idempotentHint: true },
		},
		async ({ galleryId, publish }) =>
			run(() =>
				caller.museum.updateGroup({ id: galleryId, isPublished: publish }),
			),
	);

	server.registerTool(
		"delete_gallery",
		{
			title: "Delete gallery",
			description:
				"Permanently delete a curated gallery. The member artworks themselves are kept in the archive.",
			inputSchema: { galleryId: z.string().min(1) },
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async ({ galleryId }) =>
			run(() => caller.museum.deleteGroup({ id: galleryId })),
	);

	// ── Museums (multi-room) ────────────────────────────────────────────────────
	server.registerTool(
		"list_museums",
		{
			title: "List museums",
			description:
				"List the user's multi-room museums (including drafts), each with its ordered rooms and every room's ordered artworkIds and publish state.",
			annotations: { readOnlyHint: true },
		},
		async () => run(() => caller.museum.myMuseums()),
	);

	server.registerTool(
		"create_museum",
		{
			title: "Create museum",
			description:
				"Create a new (unpublished) multi-room museum owned by the user. Returns the new museum, including its id — use that id to add rooms and configure it. A museum is a building of several rooms; for a single curated room, use create_gallery instead.",
			inputSchema: {
				name: z.string().min(1).max(120),
				tagline: z.string().max(200).optional(),
				description: z.string().max(2000).optional(),
			},
		},
		async ({ name, tagline, description }) =>
			run(() =>
				caller.museum.createMuseum({
					name,
					tagline: tagline ?? null,
					description: description ?? null,
				}),
			),
	);

	server.registerTool(
		"update_museum",
		{
			title: "Update museum",
			description:
				"Update a museum's name, tagline, description, 3D theme, and/or cover artwork. The cover must already be hung in one of the museum's rooms. See gallery://guide for theme fields.",
			inputSchema: {
				museumId: z.string().min(1),
				name: z.string().min(1).max(120).optional(),
				tagline: z.string().max(200).nullable().optional(),
				description: z.string().max(2000).nullable().optional(),
				theme: z.object(themeShape).nullable().optional(),
				coverArtworkId: z.string().min(1).nullable().optional(),
			},
			annotations: { idempotentHint: true },
		},
		async ({ museumId, ...fields }) =>
			run(() => caller.museum.updateMuseum({ id: museumId, ...fields })),
	);

	server.registerTool(
		"publish_museum",
		{
			title: "Publish / unpublish museum",
			description:
				"Set whether a museum is publicly visible in the 3D lobby. Publish only when the user is happy with it.",
			inputSchema: {
				museumId: z.string().min(1),
				publish: z.boolean(),
			},
			annotations: { idempotentHint: true },
		},
		async ({ museumId, publish }) =>
			run(() =>
				caller.museum.updateMuseum({ id: museumId, isPublished: publish }),
			),
	);

	server.registerTool(
		"delete_museum",
		{
			title: "Delete museum",
			description:
				"Permanently delete a museum and all its rooms. The member artworks themselves are kept in the archive.",
			inputSchema: { museumId: z.string().min(1) },
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async ({ museumId }) =>
			run(() => caller.museum.deleteMuseum({ id: museumId })),
	);

	server.registerTool(
		"add_room",
		{
			title: "Add room to museum",
			description:
				"Add a room to a museum, appended after the existing rooms. Returns the new room, including its id — use that id to hang artworks with set_room_artworks.",
			inputSchema: {
				museumId: z.string().min(1),
				name: z.string().min(1).max(120),
				description: z.string().max(2000).optional(),
			},
		},
		async ({ museumId, name, description }) =>
			run(() =>
				caller.museum.createRoom({
					museumId,
					name,
					description: description ?? null,
				}),
			),
	);

	server.registerTool(
		"update_room",
		{
			title: "Update room",
			description: "Update a room's name and/or description.",
			inputSchema: {
				roomId: z.string().min(1),
				name: z.string().min(1).max(120).optional(),
				description: z.string().max(2000).nullable().optional(),
			},
			annotations: { idempotentHint: true },
		},
		async ({ roomId, ...fields }) =>
			run(() => caller.museum.updateRoom({ roomId, ...fields })),
	);

	server.registerTool(
		"delete_room",
		{
			title: "Delete room",
			description:
				"Delete a room from its museum. The artworks hung in it are kept in the archive.",
			inputSchema: { roomId: z.string().min(1) },
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async ({ roomId }) => run(() => caller.museum.deleteRoom({ roomId })),
	);

	server.registerTool(
		"reorder_rooms",
		{
			title: "Reorder museum rooms",
			description:
				"Reorder a museum's rooms to match this list. Rooms you omit keep their relative order after the listed ones; ids not belonging to the museum are ignored.",
			inputSchema: {
				museumId: z.string().min(1),
				roomIds: z.array(z.string().min(1)).max(100),
			},
			annotations: { idempotentHint: true },
		},
		async ({ museumId, roomIds }) =>
			run(() => caller.museum.reorderRooms({ museumId, roomIds })),
	);

	server.registerTool(
		"add_artworks_to_room",
		{
			title: "Add artworks to a room",
			description:
				"Append artworks (by id) to a room, keeping the existing order and skipping duplicates. This auto-publishes the added artworks so they can appear in the 3D museum.",
			inputSchema: {
				roomId: z.string().min(1),
				artworkIds: z.array(z.string().min(1)).min(1),
			},
		},
		async ({ roomId, artworkIds }) =>
			run(async () => {
				const museums = await caller.museum.myMuseums();
				const target = museums
					.flatMap((m) => m.rooms)
					.find((r) => r.id === roomId);
				if (!target) throw new Error("Room not found");
				const current = target.artworkIds;
				const merged = [
					...current,
					...artworkIds.filter((id) => !current.includes(id)),
				];
				return caller.museum.setRoomArtworks({ roomId, artworkIds: merged });
			}),
	);

	server.registerTool(
		"set_room_artworks",
		{
			title: "Set / reorder room artworks",
			description:
				"Replace a room's full set of artworks with this exact ordered list (use to reorder or remove). Own artworks are auto-published.",
			inputSchema: {
				roomId: z.string().min(1),
				artworkIds: z.array(z.string().min(1)).max(200),
			},
			annotations: { idempotentHint: true },
		},
		async ({ roomId, artworkIds }) =>
			run(() => caller.museum.setRoomArtworks({ roomId, artworkIds })),
	);

	// ── Reference + workflow ────────────────────────────────────────────────────
	server.registerResource(
		"guide",
		"gallery://guide",
		{
			title: "Gallery agent guide",
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
				"Guide the agent through importing images and assembling a full curated gallery.",
			argsSchema: {
				image_urls: z
					.string()
					.optional()
					.describe("Whitespace/newline-separated image URLs to import"),
				vibe: z
					.string()
					.optional()
					.describe(
						"Desired mood/theme for the gallery, e.g. 'moody nocturnes'",
					),
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
							"Follow the workflow in the server instructions: import the images, then for each artwork fill in title, artist, type, year, medium, description, an engaging story and a few fun facts, and relevant tags. Then create the gallery, add the artworks, give it a fitting 3D theme and a cover, and show me a summary before publishing. Read gallery://guide for the exact fields and enums.",
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
