import { db } from "@aqt-gallery/db";
import {
	artwork,
	gallery,
	galleryArtwork,
	mediaAsset,
} from "@aqt-gallery/db/schema/gallery";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router } from "../index";
import { sortModes } from "./gallery-helpers";

export const galleriesRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		const userId = ctx.session.user.id;
		const rows = await db
			.select({
				id: gallery.id,
				title: gallery.title,
				description: gallery.description,
				sortMode: gallery.sortMode,
				coverAssetId: gallery.coverAssetId,
				createdAt: gallery.createdAt,
				updatedAt: gallery.updatedAt,
				coverWidth: mediaAsset.width,
				coverHeight: mediaAsset.height,
			})
			.from(gallery)
			.leftJoin(mediaAsset, eq(mediaAsset.id, gallery.coverAssetId))
			.where(eq(gallery.userId, userId))
			.orderBy(desc(gallery.updatedAt));

		return rows.map((row) => ({
			...row,
			coverUrl: row.coverAssetId ? `/media/${row.coverAssetId}/thumb` : null,
		}));
	}),

	get: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const rows = await db
				.select()
				.from(gallery)
				.where(and(eq(gallery.id, input.id), eq(gallery.userId, userId)))
				.limit(1);
			const item = rows[0];

			if (!item) {
				return null;
			}

			const membership = await db
				.select({
					artworkId: galleryArtwork.artworkId,
					position: galleryArtwork.position,
				})
				.from(galleryArtwork)
				.where(eq(galleryArtwork.galleryId, item.id))
				.orderBy(asc(galleryArtwork.position));

			return {
				gallery: item,
				artworkIds: membership.map((row) => row.artworkId),
			};
		}),

	create: protectedProcedure
		.input(
			z.object({
				title: z.string().min(1),
				description: z.string().nullable().optional(),
				sortMode: z.enum(sortModes).default("manual"),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const rows = await db
				.insert(gallery)
				.values({
					id: crypto.randomUUID(),
					userId: ctx.session.user.id,
					title: input.title,
					description: input.description ?? null,
					sortMode: input.sortMode,
				})
				.returning();

			return rows[0];
		}),

	update: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				title: z.string().min(1),
				description: z.string().nullable().optional(),
				sortMode: z.enum(sortModes),
				coverAssetId: z.string().nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const rows = await db
				.update(gallery)
				.set({
					title: input.title,
					description: input.description ?? null,
					sortMode: input.sortMode,
					coverAssetId: input.coverAssetId ?? null,
				})
				.where(
					and(
						eq(gallery.id, input.id),
						eq(gallery.userId, ctx.session.user.id),
					),
				)
				.returning();

			return rows[0] ?? null;
		}),

	delete: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await db
				.delete(gallery)
				.where(
					and(
						eq(gallery.id, input.id),
						eq(gallery.userId, ctx.session.user.id),
					),
				);
			return { ok: true };
		}),

	addArtwork: protectedProcedure
		.input(
			z.object({ galleryId: z.string().min(1), artworkId: z.string().min(1) }),
		)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const [ownedArtwork, ownedGallery] = await Promise.all([
				db
					.select({ id: artwork.id })
					.from(artwork)
					.where(
						and(eq(artwork.id, input.artworkId), eq(artwork.userId, userId)),
					)
					.limit(1),
				db
					.select({ id: gallery.id })
					.from(gallery)
					.where(
						and(eq(gallery.id, input.galleryId), eq(gallery.userId, userId)),
					)
					.limit(1),
			]);

			if (!ownedArtwork[0] || !ownedGallery[0]) {
				return { ok: false };
			}

			await db
				.insert(galleryArtwork)
				.values({
					galleryId: input.galleryId,
					artworkId: input.artworkId,
					position: Date.now(),
				})
				.onConflictDoNothing();

			return { ok: true };
		}),

	removeArtwork: protectedProcedure
		.input(
			z.object({ galleryId: z.string().min(1), artworkId: z.string().min(1) }),
		)
		.mutation(async ({ ctx, input }) => {
			const ownedGallery = await db
				.select({ id: gallery.id })
				.from(gallery)
				.where(
					and(
						eq(gallery.id, input.galleryId),
						eq(gallery.userId, ctx.session.user.id),
					),
				)
				.limit(1);

			if (!ownedGallery[0]) {
				return { ok: false };
			}

			await db
				.delete(galleryArtwork)
				.where(
					and(
						eq(galleryArtwork.galleryId, input.galleryId),
						eq(galleryArtwork.artworkId, input.artworkId),
					),
				);
			return { ok: true };
		}),

	reorderArtworks: protectedProcedure
		.input(
			z.object({
				galleryId: z.string().min(1),
				artworkIds: z.array(z.string().min(1)),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const ownedGallery = await db
				.select({ id: gallery.id })
				.from(gallery)
				.where(
					and(
						eq(gallery.id, input.galleryId),
						eq(gallery.userId, ctx.session.user.id),
					),
				)
				.limit(1);

			if (!ownedGallery[0]) {
				return { ok: false };
			}

			for (const [position, artworkId] of input.artworkIds.entries()) {
				await db
					.update(galleryArtwork)
					.set({ position })
					.where(
						and(
							eq(galleryArtwork.galleryId, input.galleryId),
							eq(galleryArtwork.artworkId, artworkId),
						),
					);
			}
			return { ok: true };
		}),
});
