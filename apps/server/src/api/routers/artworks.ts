import path from "node:path";
import { db } from "@aqt-gallery/db";
import {
	artwork,
	artworkCustomField,
	artworkTag,
	mediaAsset,
	tag,
} from "@aqt-gallery/db/schema/gallery";
import { env } from "@aqt-gallery/env/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";

import { importMediaFromUrls, uploadErrorResponse } from "../../media/upload";
import { protectedProcedure, router } from "../index";
import { artworkTypes } from "./gallery-helpers";

const artworkUpdateSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	artist: z.string().nullable().optional(),
	artworkType: z.enum(artworkTypes),
	year: z.string().nullable().optional(),
	seenAt: z.string().nullable().optional(),
	rating: z.number().int().min(0).max(5).nullable().optional(),
	review: z.string().nullable().optional(),
	thoughts: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	sourceUrl: z.string().nullable().optional(),
});

export const artworksRouter = router({
	list: protectedProcedure
		.input(
			z
				.object({
					query: z.string().optional(),
					tagId: z.string().optional(),
					artworkType: z.enum(artworkTypes).optional(),
					sort: z
						.enum(["newest", "oldest", "title", "rating"])
						.default("newest"),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const filters = [
				eq(artwork.userId, userId),
				input?.artworkType
					? eq(artwork.artworkType, input.artworkType)
					: undefined,
				input?.query
					? or(
							ilike(artwork.title, `%${input.query}%`),
							ilike(artwork.artist, `%${input.query}%`),
						)
					: undefined,
			].filter((filter) => filter !== undefined);

			const orderBy =
				input?.sort === "oldest"
					? asc(artwork.archivedAt)
					: input?.sort === "title"
						? asc(artwork.title)
						: input?.sort === "rating"
							? desc(artwork.rating)
							: desc(artwork.archivedAt);

			const rows = await db
				.select({
					id: artwork.id,
					title: artwork.title,
					artist: artwork.artist,
					artworkType: artwork.artworkType,
					rating: artwork.rating,
					archivedAt: artwork.archivedAt,
					assetId: mediaAsset.id,
					width: mediaAsset.width,
					height: mediaAsset.height,
					mimeType: mediaAsset.mimeType,
				})
				.from(artwork)
				.leftJoin(mediaAsset, eq(mediaAsset.id, artwork.primaryAssetId))
				.where(and(...filters))
				.orderBy(orderBy);

			let scopedRows = rows;

			if (input?.tagId) {
				const taggedRows = await db
					.select({ artworkId: artworkTag.artworkId })
					.from(artworkTag)
					.innerJoin(tag, eq(tag.id, artworkTag.tagId))
					.where(and(eq(tag.userId, userId), eq(tag.id, input.tagId)));
				const ids = new Set(taggedRows.map((row) => row.artworkId));
				scopedRows = scopedRows.filter((row) => ids.has(row.id));
			}

			if (scopedRows.length === 0) {
				return [];
			}

			const artworkIds = scopedRows.map((row) => row.id);
			const tagRows = await db
				.select({
					artworkId: artworkTag.artworkId,
					id: tag.id,
					name: tag.name,
					slug: tag.slug,
				})
				.from(artworkTag)
				.innerJoin(tag, eq(tag.id, artworkTag.tagId))
				.where(inArray(artworkTag.artworkId, artworkIds));

			return scopedRows.map((row) => ({
				...row,
				thumbnailUrl: row.assetId ? `/media/${row.assetId}/thumb` : null,
				originalUrl: row.assetId ? `/media/${row.assetId}/original` : null,
				tags: tagRows
					.filter((tagRow) => tagRow.artworkId === row.id)
					.map((tagRow) => ({
						id: tagRow.id,
						name: tagRow.name,
						slug: tagRow.slug,
					})),
			}));
		}),

	get: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const rows = await db
				.select()
				.from(artwork)
				.where(and(eq(artwork.id, input.id), eq(artwork.userId, userId)))
				.limit(1);
			const item = rows[0];

			if (!item) {
				return null;
			}

			const [assets, customFields, tagRows] = await Promise.all([
				db.select().from(mediaAsset).where(eq(mediaAsset.artworkId, item.id)),
				db
					.select()
					.from(artworkCustomField)
					.where(eq(artworkCustomField.artworkId, item.id))
					.orderBy(asc(artworkCustomField.position)),
				db
					.select({ id: tag.id, name: tag.name, slug: tag.slug })
					.from(artworkTag)
					.innerJoin(tag, eq(tag.id, artworkTag.tagId))
					.where(eq(artworkTag.artworkId, item.id)),
			]);

			return {
				artwork: item,
				mediaAssets: assets.map((asset) => ({
					...asset,
					thumbnailUrl: `/media/${asset.id}/thumb`,
					originalUrl: `/media/${asset.id}/original`,
				})),
				customFields,
				tags: tagRows,
			};
		}),

	update: protectedProcedure
		.input(artworkUpdateSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const seenAt = input.seenAt ? new Date(input.seenAt) : null;

			const rows = await db
				.update(artwork)
				.set({
					title: input.title,
					artist: input.artist ?? null,
					artworkType: input.artworkType,
					year: input.year ?? null,
					seenAt,
					rating: input.rating ?? null,
					review: input.review ?? null,
					thoughts: input.thoughts ?? null,
					description: input.description ?? null,
					sourceUrl: input.sourceUrl ?? null,
				})
				.where(and(eq(artwork.id, input.id), eq(artwork.userId, userId)))
				.returning();

			return rows[0] ?? null;
		}),

	delete: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await db
				.delete(artwork)
				.where(and(eq(artwork.id, input.id), eq(artwork.userId, userId)));
			return { ok: true };
		}),

	bulkUpdate: protectedProcedure
		.input(z.object({ artworks: z.array(artworkUpdateSchema) }))
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const updated = [];

			for (const item of input.artworks) {
				const rows = await db
					.update(artwork)
					.set({
						title: item.title,
						artist: item.artist ?? null,
						artworkType: item.artworkType,
						year: item.year ?? null,
						seenAt: item.seenAt ? new Date(item.seenAt) : null,
						rating: item.rating ?? null,
						review: item.review ?? null,
						thoughts: item.thoughts ?? null,
						description: item.description ?? null,
						sourceUrl: item.sourceUrl ?? null,
					})
					.where(and(eq(artwork.id, item.id), eq(artwork.userId, userId)))
					.returning();
				if (rows[0]) {
					updated.push(rows[0]);
				}
			}

			return updated;
		}),

	/** Import artworks from remote image URLs. Each URL is downloaded once
	 * and stored as a media asset (same as an upload) so the gallery never
	 * relies on the third-party URL afterwards. */
	importFromUrl: protectedProcedure
		.input(
			z.object({
				items: z
					.array(
						z.object({
							url: z.string().url(),
							title: z.string().min(1).max(200).optional(),
						}),
					)
					.min(1)
					.max(25),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const result = await Effect.runPromise(
				importMediaFromUrls({
					items: input.items,
					uploadRoot: path.resolve(env.UPLOAD_DIR),
					userId: ctx.session.user.id,
				}).pipe(
					Effect.match({
						onFailure: (error) => ({
							ok: false as const,
							error: uploadErrorResponse(error).body.error,
						}),
						onSuccess: (uploaded) => ({ ok: true as const, uploaded }),
					}),
				),
			);
			if (!result.ok) {
				throw new TRPCError({ code: "BAD_REQUEST", message: result.error });
			}
			return {
				imported: result.uploaded.map((u) => ({
					artworkId: u.artworkId,
					title: u.title,
				})),
			};
		}),

	createDraftFromUpload: protectedProcedure
		.input(z.object({ title: z.string().min(1), assetId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const id = crypto.randomUUID();
			const rows = await db
				.insert(artwork)
				.values({
					id,
					userId,
					title: input.title,
					artworkType: "other",
					primaryAssetId: input.assetId,
				})
				.returning();
			return rows[0];
		}),

	setCustomFields: protectedProcedure
		.input(
			z.object({
				artworkId: z.string().min(1),
				fields: z.array(
					z.object({
						label: z.string().min(1),
						value: z.string(),
						position: z.number().int(),
					}),
				),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const ownedRows = await db
				.select({ id: artwork.id })
				.from(artwork)
				.where(
					and(
						eq(artwork.id, input.artworkId),
						eq(artwork.userId, ctx.session.user.id),
					),
				)
				.limit(1);

			if (!ownedRows[0]) {
				return [];
			}

			await db
				.delete(artworkCustomField)
				.where(eq(artworkCustomField.artworkId, input.artworkId));

			if (input.fields.length === 0) {
				return [];
			}

			return db
				.insert(artworkCustomField)
				.values(
					input.fields.map((field) => ({
						id: crypto.randomUUID(),
						artworkId: input.artworkId,
						label: field.label,
						value: field.value,
						position: field.position,
					})),
				)
				.returning();
		}),
});
