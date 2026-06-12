import { db } from "@aqt-gallery/db";
import { artist, artwork, mediaAsset } from "@aqt-gallery/db/schema/gallery";
import {
	artGroup,
	groupArtwork,
	type MuseumTheme,
	museum,
	placement,
	room,
} from "@aqt-gallery/db/schema/museum";
import { env } from "@aqt-gallery/env/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, publicProcedure, router } from "../index";

/** All imagery is served by this API (downloaded + cached server-side);
 * the browser never fetches the stored source URLs directly. */
function publicImageUrl(
	entity: "artwork" | "museum" | "group",
	id: string,
	variant: "full" | "thumb" | "cover",
) {
	return `${env.BETTER_AUTH_URL}/public-image/${entity}/${id}/${variant}`;
}

/** Public artwork payload for the 3D museum. Only published artworks
 * are ever returned; personal-archive fields (rating, review…) stay private.
 * Uploaded artworks (no external imageUrl) fall back to their primary
 * media asset for image presence and pixel dimensions. */
function toPublicArtwork(
	a: typeof artwork.$inferSelect,
	artistRow: typeof artist.$inferSelect | null,
	asset: { width: number | null; height: number | null } | null,
) {
	const hasImage = Boolean(a.imageUrl || asset);
	return {
		id: a.id,
		title: a.title,
		artistName: artistRow?.name ?? a.artist,
		artist: artistRow
			? {
					id: artistRow.id,
					slug: artistRow.slug,
					name: artistRow.name,
					bio: artistRow.bio,
					birthYear: artistRow.birthYear,
					deathYear: artistRow.deathYear,
					nationality: artistRow.nationality,
				}
			: null,
		year: a.year,
		medium: a.medium,
		dimensions: a.dimensions,
		description: a.description,
		story: a.story,
		funFacts: a.funFacts ?? [],
		imageUrl: hasImage ? publicImageUrl("artwork", a.id, "full") : null,
		thumbnailUrl: hasImage ? publicImageUrl("artwork", a.id, "thumb") : null,
		imageWidth: a.imageWidth ?? asset?.width ?? null,
		imageHeight: a.imageHeight ?? asset?.height ?? null,
	};
}

export type PublicArtwork = ReturnType<typeof toPublicArtwork>;

async function loadArtworksWithArtists(artworkIds: string[]) {
	if (artworkIds.length === 0) {
		return new Map<string, PublicArtwork>();
	}
	const rows = await db
		.select()
		.from(artwork)
		.leftJoin(artist, eq(artist.id, artwork.artistId))
		.leftJoin(mediaAsset, eq(mediaAsset.id, artwork.primaryAssetId))
		.where(and(inArray(artwork.id, artworkIds), eq(artwork.isPublished, true)));
	return new Map(
		rows.map((row) => [
			row.artwork.id,
			toPublicArtwork(
				row.artwork,
				row.artist,
				row.media_asset
					? { width: row.media_asset.width, height: row.media_asset.height }
					: null,
			),
		]),
	);
}

function slugify(name: string) {
	return (
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "gallery"
	);
}

/** Slugs are globally unique across groups; suffix on collision. */
async function uniqueGroupSlug(name: string) {
	const base = slugify(name);
	for (let i = 0; i < 50; i++) {
		const candidate = i === 0 ? base : `${base}-${i + 1}`;
		const existing = await db
			.select({ id: artGroup.id })
			.from(artGroup)
			.where(eq(artGroup.slug, candidate))
			.limit(1);
		if (!existing[0]) {
			return candidate;
		}
	}
	return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

const themeInput = z.object({
	wallColor: z.string().optional(),
	accentWallColor: z.string().optional(),
	floorColor: z.string().optional(),
	floorRoughness: z.number().min(0).max(1).optional(),
	ambientIntensity: z.number().min(0).max(5).optional(),
	lightTemperature: z.enum(["warm", "neutral", "cool"]).optional(),
}) satisfies z.ZodType<MuseumTheme>;

async function requireOwnGroup(groupId: string, userId: string) {
	const rows = await db
		.select()
		.from(artGroup)
		.where(and(eq(artGroup.id, groupId), eq(artGroup.createdBy, userId)))
		.limit(1);
	const g = rows[0];
	if (!g) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Gallery not found" });
	}
	return g;
}

export const museumRouter = router({
	/** Everything the lobby needs: published museums (with room counts)
	 * and published groups (exhibitions, artist collections). */
	lobby: publicProcedure.query(async () => {
		const [museums, rooms, groups, groupCounts] = await Promise.all([
			db
				.select()
				.from(museum)
				.where(eq(museum.isPublished, true))
				.orderBy(asc(museum.sortOrder)),
			db
				.select({
					id: room.id,
					museumId: room.museumId,
					name: room.name,
				})
				.from(room)
				.orderBy(asc(room.sortOrder)),
			db
				.select()
				.from(artGroup)
				.where(eq(artGroup.isPublished, true))
				.orderBy(asc(artGroup.sortOrder)),
			db
				.select({
					groupId: groupArtwork.groupId,
					artworkId: groupArtwork.artworkId,
					position: groupArtwork.position,
				})
				.from(groupArtwork)
				.orderBy(asc(groupArtwork.position)),
		]);

		const roomCountByMuseum = new Map<
			string,
			{ count: number; names: string[] }
		>();
		for (const r of rooms) {
			const entry = roomCountByMuseum.get(r.museumId) ?? {
				count: 0,
				names: [],
			};
			entry.count += 1;
			entry.names.push(r.name);
			roomCountByMuseum.set(r.museumId, entry);
		}
		const placementRows = await db
			.select({ roomId: placement.roomId, artworkId: placement.artworkId })
			.from(placement);
		const roomIdToMuseum = new Map(rooms.map((r) => [r.id, r.museumId]));
		const artworkCountByMuseum = new Map<string, number>();
		for (const p of placementRows) {
			const mId = roomIdToMuseum.get(p.roomId);
			if (mId) {
				artworkCountByMuseum.set(mId, (artworkCountByMuseum.get(mId) ?? 0) + 1);
			}
		}
		const artworkCountByGroup = new Map<string, number>();
		const firstArtworkByGroup = new Map<string, string>();
		for (const g of groupCounts) {
			artworkCountByGroup.set(
				g.groupId,
				(artworkCountByGroup.get(g.groupId) ?? 0) + 1,
			);
			if (!firstArtworkByGroup.has(g.groupId)) {
				firstArtworkByGroup.set(g.groupId, g.artworkId);
			}
		}

		return {
			museums: museums.map((m) => ({
				id: m.id,
				slug: m.slug,
				name: m.name,
				tagline: m.tagline,
				description: m.description,
				coverImageUrl: m.coverImageUrl
					? publicImageUrl("museum", m.id, "cover")
					: null,
				theme: m.theme,
				roomCount: roomCountByMuseum.get(m.id)?.count ?? 0,
				roomNames: roomCountByMuseum.get(m.id)?.names ?? [],
				artworkCount: artworkCountByMuseum.get(m.id) ?? 0,
			})),
			groups: groups.map((g) => {
				const firstArtworkId = firstArtworkByGroup.get(g.id);
				return {
					id: g.id,
					slug: g.slug,
					kind: g.kind,
					name: g.name,
					tagline: g.tagline,
					description: g.description,
					coverImageUrl: g.coverImageUrl
						? publicImageUrl("group", g.id, "cover")
						: firstArtworkId
							? publicImageUrl("artwork", firstArtworkId, "thumb")
							: null,
					theme: g.theme,
					artworkCount: artworkCountByGroup.get(g.id) ?? 0,
				};
			}),
		};
	}),

	/** Full payload to render a museum in 3D: rooms in order, each with
	 * ordered placements joined to published artworks + artists. */
	museum: publicProcedure
		.input(z.object({ slug: z.string().min(1) }))
		.query(async ({ input }) => {
			const museumRows = await db
				.select()
				.from(museum)
				.where(and(eq(museum.slug, input.slug), eq(museum.isPublished, true)))
				.limit(1);
			const m = museumRows[0];
			if (!m) {
				return null;
			}

			const rooms = await db
				.select()
				.from(room)
				.where(eq(room.museumId, m.id))
				.orderBy(asc(room.sortOrder));

			const placements =
				rooms.length === 0
					? []
					: await db
							.select()
							.from(placement)
							.where(
								inArray(
									placement.roomId,
									rooms.map((r) => r.id),
								),
							)
							.orderBy(asc(placement.position));

			const artworkMap = await loadArtworksWithArtists(
				placements.map((p) => p.artworkId),
			);

			return {
				id: m.id,
				slug: m.slug,
				name: m.name,
				tagline: m.tagline,
				description: m.description,
				theme: m.theme,
				rooms: rooms.map((r) => ({
					id: r.id,
					slug: r.slug,
					name: r.name,
					description: r.description,
					layout: r.layout,
					artworks: placements
						.filter((p) => p.roomId === r.id)
						.flatMap((p) => {
							const art = artworkMap.get(p.artworkId);
							if (!art) return [];
							return [
								{
									...art,
									placement: {
										position: p.position,
										wall: p.wall,
										wallOffset: p.wallOffset,
										scale: p.scale,
									},
								},
							];
						}),
				})),
			};
		}),

	/** Full payload to render a group (exhibition / artist collection /
	 * custom collection) as a single auto-generated 3D gallery.
	 * Owners can also preview their own not-yet-published galleries. */
	group: publicProcedure
		.input(z.object({ slug: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const viewerId = ctx.session?.user.id;
			const groupRows = await db
				.select()
				.from(artGroup)
				.leftJoin(artist, eq(artist.id, artGroup.artistId))
				.where(
					and(
						eq(artGroup.slug, input.slug),
						viewerId
							? or(
									eq(artGroup.isPublished, true),
									eq(artGroup.createdBy, viewerId),
								)
							: eq(artGroup.isPublished, true),
					),
				)
				.limit(1);
			const g = groupRows[0];
			if (!g) {
				return null;
			}

			const memberships = await db
				.select()
				.from(groupArtwork)
				.where(eq(groupArtwork.groupId, g.art_group.id))
				.orderBy(asc(groupArtwork.position));

			const artworkMap = await loadArtworksWithArtists(
				memberships.map((mw) => mw.artworkId),
			);

			return {
				id: g.art_group.id,
				slug: g.art_group.slug,
				kind: g.art_group.kind,
				name: g.art_group.name,
				tagline: g.art_group.tagline,
				description: g.art_group.description,
				theme: g.art_group.theme,
				isPublished: g.art_group.isPublished,
				isOwner: Boolean(viewerId && g.art_group.createdBy === viewerId),
				artist: g.artist
					? {
							id: g.artist.id,
							slug: g.artist.slug,
							name: g.artist.name,
							bio: g.artist.bio,
							birthYear: g.artist.birthYear,
							deathYear: g.artist.deathYear,
							nationality: g.artist.nationality,
						}
					: null,
				rooms: [
					{
						id: g.art_group.id,
						slug: g.art_group.slug,
						name: g.art_group.name,
						description: g.art_group.description,
						layout: null,
						artworks: memberships.flatMap((mw) => {
							const art = artworkMap.get(mw.artworkId);
							if (!art) return [];
							return [
								{
									...art,
									placement: {
										position: mw.position,
										wall: null,
										wallOffset: null,
										scale: null,
									},
								},
							];
						}),
					},
				],
			};
		}),

	/** The signed-in user's own curated 3D galleries (including drafts),
	 * with ordered membership so the studio can edit without extra round
	 * trips. */
	myGroups: protectedProcedure.query(async ({ ctx }) => {
		const userId = ctx.session.user.id;
		const groups = await db
			.select()
			.from(artGroup)
			.where(eq(artGroup.createdBy, userId))
			.orderBy(desc(artGroup.updatedAt));
		const memberships =
			groups.length === 0
				? []
				: await db
						.select({
							groupId: groupArtwork.groupId,
							artworkId: groupArtwork.artworkId,
						})
						.from(groupArtwork)
						.where(
							inArray(
								groupArtwork.groupId,
								groups.map((g) => g.id),
							),
						)
						.orderBy(asc(groupArtwork.position));

		const artworkIdsByGroup = new Map<string, string[]>();
		for (const m of memberships) {
			const list = artworkIdsByGroup.get(m.groupId) ?? [];
			list.push(m.artworkId);
			artworkIdsByGroup.set(m.groupId, list);
		}

		return groups.map((g) => {
			const artworkIds = artworkIdsByGroup.get(g.id) ?? [];
			return {
				id: g.id,
				slug: g.slug,
				kind: g.kind,
				name: g.name,
				tagline: g.tagline,
				description: g.description,
				theme: g.theme,
				isPublished: g.isPublished,
				coverImageUrl: g.coverImageUrl
					? publicImageUrl("group", g.id, "cover")
					: artworkIds[0]
						? publicImageUrl("artwork", artworkIds[0], "thumb")
						: null,
				artworkIds,
				updatedAt: g.updatedAt,
			};
		});
	}),

	/** Create a new (unpublished) curated gallery owned by the caller. */
	createGroup: protectedProcedure
		.input(
			z.object({
				name: z.string().min(1).max(120),
				tagline: z.string().max(200).nullable().optional(),
				description: z.string().max(2000).nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const slug = await uniqueGroupSlug(input.name);
			const rows = await db
				.insert(artGroup)
				.values({
					id: crypto.randomUUID(),
					slug,
					kind: "custom",
					name: input.name,
					tagline: input.tagline ?? null,
					description: input.description ?? null,
					createdBy: ctx.session.user.id,
					isPublished: false,
				})
				.returning();
			return rows[0];
		}),

	updateGroup: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				name: z.string().min(1).max(120).optional(),
				tagline: z.string().max(200).nullable().optional(),
				description: z.string().max(2000).nullable().optional(),
				theme: themeInput.nullable().optional(),
				isPublished: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await requireOwnGroup(input.id, ctx.session.user.id);
			const rows = await db
				.update(artGroup)
				.set({
					...(input.name !== undefined ? { name: input.name } : {}),
					...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
					...(input.description !== undefined
						? { description: input.description }
						: {}),
					...(input.theme !== undefined ? { theme: input.theme } : {}),
					...(input.isPublished !== undefined
						? { isPublished: input.isPublished }
						: {}),
				})
				.where(eq(artGroup.id, input.id))
				.returning();
			return rows[0];
		}),

	deleteGroup: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await requireOwnGroup(input.id, ctx.session.user.id);
			await db.delete(artGroup).where(eq(artGroup.id, input.id));
			return { ok: true };
		}),

	/** Replace a gallery's artworks with the given ordered list — the
	 * single sync point the studio calls after any add/remove/reorder.
	 * Callers may hang their own artworks (auto-published so the public
	 * image route can serve them) or any already-published artwork. */
	setGroupArtworks: protectedProcedure
		.input(
			z.object({
				groupId: z.string().min(1),
				artworkIds: z.array(z.string().min(1)).max(200),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await requireOwnGroup(input.groupId, userId);

			const unique = [...new Set(input.artworkIds)];
			const allowed =
				unique.length === 0
					? []
					: await db
							.select({ id: artwork.id, userId: artwork.userId })
							.from(artwork)
							.where(
								and(
									inArray(artwork.id, unique),
									or(eq(artwork.userId, userId), eq(artwork.isPublished, true)),
								),
							);
			const allowedIds = new Set(allowed.map((a) => a.id));
			const ordered = unique.filter((id) => allowedIds.has(id));

			const ownArtworkIds = allowed
				.filter((a) => a.userId === userId)
				.map((a) => a.id);
			if (ownArtworkIds.length > 0) {
				await db
					.update(artwork)
					.set({ isPublished: true })
					.where(
						and(inArray(artwork.id, ownArtworkIds), eq(artwork.userId, userId)),
					);
			}

			await db
				.delete(groupArtwork)
				.where(eq(groupArtwork.groupId, input.groupId));
			if (ordered.length > 0) {
				await db.insert(groupArtwork).values(
					ordered.map((artworkId, position) => ({
						groupId: input.groupId,
						artworkId,
						position,
					})),
				);
			}
			await db
				.update(artGroup)
				.set({ updatedAt: new Date() })
				.where(eq(artGroup.id, input.groupId));

			return { ok: true, artworkIds: ordered };
		}),
});
