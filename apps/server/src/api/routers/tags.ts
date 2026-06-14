import { db } from "@aqt-gallery/db";
import { artwork, artworkTag, tag } from "@aqt-gallery/db/schema/gallery";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router } from "../index";
import { slugify } from "./gallery-helpers";

export const tagsRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		return db
			.select()
			.from(tag)
			.where(eq(tag.userId, ctx.session.user.id))
			.orderBy(asc(tag.name));
	}),

	upsert: protectedProcedure
		.input(z.object({ name: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const slug = slugify(input.name);

			// Insert-first (no-op on conflict) then re-select, so concurrent
			// upserts can't collide on the unique index.
			const inserted = await db
				.insert(tag)
				.values({ id: crypto.randomUUID(), userId, name: input.name, slug })
				.onConflictDoNothing({ target: [tag.userId, tag.slug] })
				.returning();

			if (inserted[0]) {
				return inserted[0];
			}

			const existing = await db
				.select()
				.from(tag)
				.where(and(eq(tag.userId, userId), eq(tag.slug, slug)))
				.limit(1);

			return existing[0];
		}),

	setArtworkTags: protectedProcedure
		.input(
			z.object({
				artworkId: z.string().min(1),
				tagNames: z.array(z.string().min(1)),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const ownedRows = await db
				.select({ id: artwork.id })
				.from(artwork)
				.where(and(eq(artwork.id, input.artworkId), eq(artwork.userId, userId)))
				.limit(1);

			if (!ownedRows[0]) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Artwork not found",
				});
			}

			const tagIds = [];

			for (const name of input.tagNames) {
				const slug = slugify(name);
				// Insert-first then re-select on conflict; same race guard as `upsert`.
				const inserted = await db
					.insert(tag)
					.values({ id: crypto.randomUUID(), userId, name, slug })
					.onConflictDoNothing({ target: [tag.userId, tag.slug] })
					.returning();
				const row =
					inserted[0] ??
					(
						await db
							.select()
							.from(tag)
							.where(and(eq(tag.userId, userId), eq(tag.slug, slug)))
							.limit(1)
					)[0];
				if (row) {
					tagIds.push(row.id);
				}
			}

			await db
				.delete(artworkTag)
				.where(eq(artworkTag.artworkId, input.artworkId));

			// De-dup: "Art" and "art" slugify to one id that would self-collide.
			const uniqueTagIds = [...new Set(tagIds)];
			if (uniqueTagIds.length > 0) {
				await db
					.insert(artworkTag)
					.values(
						uniqueTagIds.map((tagId) => ({
							artworkId: input.artworkId,
							tagId,
						})),
					)
					.onConflictDoNothing();
			}

			if (tagIds.length === 0) {
				return [];
			}

			return db.select().from(tag).where(inArray(tag.id, tagIds));
		}),
});
