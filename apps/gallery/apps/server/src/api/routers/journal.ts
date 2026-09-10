import { db } from "@aqt-gallery/db";
import { exhibition, placement, room } from "@aqt-gallery/db/schema/exhibition";
import { artwork, visit, visitArtwork } from "@aqt-gallery/db/schema/gallery";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router } from "../index";
import { loadExhibitionRender, uniqueExhibitionSlug } from "./exhibitions";

const optionalText = z.string().max(2_000).nullable().optional();
const dateString = z
	.string()
	.refine((value) => !Number.isNaN(new Date(value).getTime()), {
		message: "Use an ISO date such as 2026-07-15",
	});

const visitFields = z.object({
	title: z.string().min(1).max(160),
	venueName: z.string().max(160).nullable().optional(),
	city: z.string().max(120).nullable().optional(),
	country: z.string().max(120).nullable().optional(),
	address: z.string().max(300).nullable().optional(),
	latitude: z.number().min(-90).max(90).nullable().optional(),
	longitude: z.number().min(-180).max(180).nullable().optional(),
	startedAt: dateString.optional(),
	endedAt: dateString.nullable().optional(),
	notes: optionalText,
	isPublic: z.boolean().optional(),
});

async function assertOwnedArtworkIds(userId: string, artworkIds: string[]) {
	const uniqueIds = [...new Set(artworkIds)];
	if (uniqueIds.length === 0) return uniqueIds;
	const rows = await db
		.select({ id: artwork.id })
		.from(artwork)
		.where(
			and(
				inArray(artwork.id, uniqueIds),
				eq(artwork.userId, userId),
				isNull(artwork.deletedAt),
			),
		);
	if (rows.length !== uniqueIds.length) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Every artwork must belong to your active archive",
		});
	}
	return uniqueIds;
}

async function requireVisit(id: string, userId: string) {
	const rows = await db
		.select({ id: visit.id })
		.from(visit)
		.where(and(eq(visit.id, id), eq(visit.userId, userId)))
		.limit(1);
	if (!rows[0])
		throw new TRPCError({ code: "NOT_FOUND", message: "Visit not found" });
}

/** The compact artwork shape used by the history explorer. Keeping it here
 * avoids sending the archive's editing fields when a visitor is just moving
 * through their encounters. */
const historyArtworkFields = {
	id: artwork.id,
	title: artwork.title,
	artist: artwork.artist,
	imageUrl: artwork.imageUrl,
	thumbnailUrl: artwork.thumbnailUrl,
	medium: artwork.medium,
	year: artwork.year,
	rating: artwork.rating,
};

function placeLabel(entry: {
	venueName: string | null;
	city: string | null;
	country: string | null;
}) {
	return [entry.venueName, entry.city, entry.country]
		.filter((value): value is string => Boolean(value))
		.join(", ");
}

/** A journal collection is an exhibition of kind "personal": private to its
 * owner, never published, with the owner's notes on each hang in its single
 * "main" room. */
const PERSONAL_ROOM_SLUG = "main";

function isPersonalCollection(userId: string, collectionId: string) {
	return and(
		eq(exhibition.id, collectionId),
		eq(exhibition.createdBy, userId),
		eq(exhibition.kind, "personal"),
	);
}

async function requirePersonalCollection(userId: string, collectionId: string) {
	const rows = await db
		.select({ exhibition, room })
		.from(exhibition)
		.innerJoin(
			room,
			and(
				eq(room.exhibitionId, exhibition.id),
				eq(room.slug, PERSONAL_ROOM_SLUG),
			),
		)
		.where(isPersonalCollection(userId, collectionId))
		.limit(1);
	const found = rows[0];
	if (!found) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Collection not found" });
	}
	return found;
}

function toCollectionSummary(
	entry: typeof exhibition.$inferSelect,
	members: readonly { artworkId: string; note: string | null }[],
) {
	const artworkNotes: Record<string, string> = {};
	for (const member of members) {
		if (member.note) artworkNotes[member.artworkId] = member.note;
	}
	return {
		id: entry.id,
		slug: entry.slug,
		name: entry.name,
		description: entry.description,
		coverArtworkId: entry.coverArtworkId,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		artworkIds: members.map((member) => member.artworkId),
		artworkNotes,
	};
}

export const journalRouter = router({
	overview: protectedProcedure.query(async ({ ctx }) => {
		const userId = ctx.session.user.id;
		const visits = await db
			.select()
			.from(visit)
			.where(eq(visit.userId, userId))
			.orderBy(desc(visit.startedAt));
		if (visits.length === 0) {
			return { visits: [], places: [], artists: [], artworkCount: 0 };
		}

		const members = await db
			.select({
				visitId: visitArtwork.visitId,
				position: visitArtwork.position,
				artwork: historyArtworkFields,
			})
			.from(visitArtwork)
			.innerJoin(artwork, eq(visitArtwork.artworkId, artwork.id))
			.where(
				and(
					inArray(
						visitArtwork.visitId,
						visits.map((entry) => entry.id),
					),
					isNull(artwork.deletedAt),
				),
			)
			.orderBy(visitArtwork.position);

		const artworksByVisit = new Map<
			string,
			(typeof members)[number]["artwork"][]
		>();
		const seenArtworkIds = new Set<string>();
		const artistCounts = new Map<string, number>();
		for (const member of members) {
			const visitArtworks = artworksByVisit.get(member.visitId) ?? [];
			visitArtworks.push(member.artwork);
			artworksByVisit.set(member.visitId, visitArtworks);
			seenArtworkIds.add(member.artwork.id);
			if (member.artwork.artist) {
				artistCounts.set(
					member.artwork.artist,
					(artistCounts.get(member.artwork.artist) ?? 0) + 1,
				);
			}
		}

		const placesByKey = new Map<
			string,
			{
				label: string;
				visitCount: number;
				artworkIds: Set<string>;
				lastVisitedAt: Date;
			}
		>();
		for (const entry of visits) {
			const label = placeLabel(entry);
			if (!label) continue;
			const existing = placesByKey.get(label) ?? {
				label,
				visitCount: 0,
				artworkIds: new Set<string>(),
				lastVisitedAt: entry.startedAt,
			};
			existing.visitCount += 1;
			if (entry.startedAt > existing.lastVisitedAt)
				existing.lastVisitedAt = entry.startedAt;
			for (const work of artworksByVisit.get(entry.id) ?? []) {
				existing.artworkIds.add(work.id);
			}
			placesByKey.set(label, existing);
		}

		return {
			visits: visits.map((entry) => ({
				...entry,
				placeLabel: placeLabel(entry),
				artworks: artworksByVisit.get(entry.id) ?? [],
			})),
			places: [...placesByKey.values()]
				.map((entry) => ({
					label: entry.label,
					visitCount: entry.visitCount,
					artworkCount: entry.artworkIds.size,
					lastVisitedAt: entry.lastVisitedAt,
				}))
				.sort((a, b) => b.lastVisitedAt.getTime() - a.lastVisitedAt.getTime()),
			artists: [...artistCounts.entries()]
				.map(([name, artworkCount]) => ({ name, artworkCount }))
				.sort(
					(a, b) =>
						b.artworkCount - a.artworkCount || a.name.localeCompare(b.name),
				)
				.slice(0, 12),
			artworkCount: seenArtworkIds.size,
		};
	}),
	visits: router({
		list: protectedProcedure.query(async ({ ctx }) => {
			const userId = ctx.session.user.id;
			const visits = await db
				.select()
				.from(visit)
				.where(eq(visit.userId, userId))
				.orderBy(desc(visit.startedAt));
			const memberships =
				visits.length === 0
					? []
					: await db
							.select({
								visitId: visitArtwork.visitId,
								artworkId: visitArtwork.artworkId,
							})
							.from(visitArtwork)
							.where(
								inArray(
									visitArtwork.visitId,
									visits.map((entry) => entry.id),
								),
							)
							.orderBy(visitArtwork.position);
			const byVisit = new Map<string, string[]>();
			for (const member of memberships) {
				const ids = byVisit.get(member.visitId) ?? [];
				ids.push(member.artworkId);
				byVisit.set(member.visitId, ids);
			}
			return visits.map((entry) => ({
				...entry,
				artworkIds: byVisit.get(entry.id) ?? [],
			}));
		}),
		create: protectedProcedure
			.input(visitFields)
			.mutation(async ({ ctx, input }) => {
				const rows = await db
					.insert(visit)
					.values({
						id: crypto.randomUUID(),
						userId: ctx.session.user.id,
						...input,
						startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
						endedAt: input.endedAt ? new Date(input.endedAt) : null,
					})
					.returning();
				return rows[0];
			}),
		update: protectedProcedure
			.input(visitFields.partial().extend({ id: z.string().min(1) }))
			.mutation(async ({ ctx, input }) => {
				await requireVisit(input.id, ctx.session.user.id);
				const { id, startedAt, endedAt, ...fields } = input;
				const rows = await db
					.update(visit)
					.set({
						...fields,
						...(startedAt === undefined
							? {}
							: { startedAt: new Date(startedAt) }),
						...(endedAt === undefined
							? {}
							: { endedAt: endedAt ? new Date(endedAt) : null }),
					})
					.where(and(eq(visit.id, id), eq(visit.userId, ctx.session.user.id)))
					.returning();
				return rows[0];
			}),
		setArtworks: protectedProcedure
			.input(
				z.object({
					visitId: z.string().min(1),
					artworkIds: z.array(z.string().min(1)).max(500),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const userId = ctx.session.user.id;
				await requireVisit(input.visitId, userId);
				const artworkIds = await assertOwnedArtworkIds(
					userId,
					input.artworkIds,
				);
				await db.transaction(async (tx) => {
					await tx
						.delete(visitArtwork)
						.where(eq(visitArtwork.visitId, input.visitId));
					if (artworkIds.length > 0) {
						await tx.insert(visitArtwork).values(
							artworkIds.map((artworkId, position) => ({
								visitId: input.visitId,
								artworkId,
								position,
							})),
						);
					}
				});
				return { artworkIds };
			}),
	}),
	collections: router({
		list: protectedProcedure.query(async ({ ctx }) => {
			const userId = ctx.session.user.id;
			const collections = await db
				.select()
				.from(exhibition)
				.where(
					and(
						eq(exhibition.createdBy, userId),
						eq(exhibition.kind, "personal"),
					),
				)
				.orderBy(desc(exhibition.updatedAt));
			const memberships =
				collections.length === 0
					? []
					: await db
							.select({
								collectionId: room.exhibitionId,
								artworkId: placement.artworkId,
								note: placement.note,
							})
							.from(placement)
							.innerJoin(room, eq(room.id, placement.roomId))
							.where(
								inArray(
									room.exhibitionId,
									collections.map((entry) => entry.id),
								),
							)
							.orderBy(asc(placement.position));
			const byCollection = new Map<string, typeof memberships>();
			for (const member of memberships) {
				const list = byCollection.get(member.collectionId) ?? [];
				list.push(member);
				byCollection.set(member.collectionId, list);
			}
			return collections.map((entry) =>
				toCollectionSummary(entry, byCollection.get(entry.id) ?? []),
			);
		}),
		/** The renderer payload for a private collection, in the same shape as
		 * `exhibitions.bySlug` so the 2D/3D exhibit views are shared. */
		exhibit: protectedProcedure
			.input(z.object({ collectionId: z.string().min(1) }))
			.query(async ({ ctx, input }) => {
				const userId = ctx.session.user.id;
				const rows = await db
					.select()
					.from(exhibition)
					.where(isPersonalCollection(userId, input.collectionId))
					.limit(1);
				const collection = rows[0];
				if (!collection) return null;
				return loadExhibitionRender(collection, null, userId);
			}),
		create: protectedProcedure
			.input(
				z.object({
					name: z.string().min(1).max(120),
					description: optionalText,
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const id = crypto.randomUUID();
				const slug = await uniqueExhibitionSlug(input.name);
				const created = await db.transaction(async (tx) => {
					const rows = await tx
						.insert(exhibition)
						.values({
							id,
							slug,
							kind: "personal",
							name: input.name,
							description: input.description ?? null,
							createdBy: ctx.session.user.id,
							isPublished: false,
						})
						.returning();
					await tx.insert(room).values({
						id: crypto.randomUUID(),
						exhibitionId: id,
						slug: PERSONAL_ROOM_SLUG,
						name: input.name,
						sortOrder: 0,
					});
					return rows[0];
				});
				if (!created) {
					throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
				}
				return toCollectionSummary(created, []);
			}),
		save: protectedProcedure
			.input(
				z.object({
					collectionId: z.string().min(1),
					name: z.string().min(1).max(120),
					description: optionalText,
					artworkIds: z.array(z.string().min(1)).max(500),
					notes: z
						.record(z.string().min(1), z.string().max(1_000).nullable())
						.optional(),
					coverArtworkId: z.string().min(1).nullable(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const userId = ctx.session.user.id;
				const { room: mainRoom } = await requirePersonalCollection(
					userId,
					input.collectionId,
				);
				const artworkIds = await assertOwnedArtworkIds(
					userId,
					input.artworkIds,
				);
				if (
					input.coverArtworkId &&
					!artworkIds.includes(input.coverArtworkId)
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "The cover artwork must belong to this collection",
					});
				}

				return db.transaction(async (tx) => {
					await tx.delete(placement).where(eq(placement.roomId, mainRoom.id));
					if (artworkIds.length > 0) {
						await tx.insert(placement).values(
							artworkIds.map((artworkId, position) => ({
								roomId: mainRoom.id,
								artworkId,
								position,
								note: input.notes?.[artworkId] ?? null,
							})),
						);
					}
					await tx
						.update(room)
						.set({ name: input.name })
						.where(eq(room.id, mainRoom.id));
					const rows = await tx
						.update(exhibition)
						.set({
							name: input.name,
							description: input.description,
							coverArtworkId: input.coverArtworkId,
						})
						.where(isPersonalCollection(userId, input.collectionId))
						.returning();
					const saved = rows[0];
					if (!saved) {
						throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
					}
					return toCollectionSummary(
						saved,
						artworkIds.map((artworkId) => ({
							artworkId,
							note: input.notes?.[artworkId] ?? null,
						})),
					);
				});
			}),
	}),
});
