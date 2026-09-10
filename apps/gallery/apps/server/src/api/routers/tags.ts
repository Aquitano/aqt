import { db } from "@aqt-gallery/db";
import { artwork, artworkTag, tag } from "@aqt-gallery/db/schema/gallery";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router } from "../index";
import { slugify } from "./gallery-helpers";

export const setArtworkTagsSchema = z.object({
	artworkId: z.string().min(1),
	tagNames: z.array(z.string().min(1).max(100)).max(50),
});

/** Replace an artwork's tags with the named set, creating tags on demand.
 * Shared by the `setArtworkTags` mutation and the batch `artworks.enrich`. */
export async function replaceArtworkTags(
	userId: string,
	input: z.infer<typeof setArtworkTagsSchema>,
) {
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

	// De-dup by slug up front: "Art" and "art" collapse to one tag. First
	// name spelling wins. Then upsert all names in one statement and
	// resolve their ids in one select, instead of a round trip per name.
	const nameBySlug = new Map<string, string>();
	for (const name of input.tagNames) {
		const slug = slugify(name);
		if (!nameBySlug.has(slug)) nameBySlug.set(slug, name);
	}
	const slugs = [...nameBySlug.keys()];

	if (slugs.length > 0) {
		// Insert-first (no-op on conflict) so concurrent calls can't collide
		// on the unique index; same race guard as `upsert`.
		await db
			.insert(tag)
			.values(
				[...nameBySlug].map(([slug, name]) => ({
					id: crypto.randomUUID(),
					userId,
					name,
					slug,
				})),
			)
			.onConflictDoNothing({ target: [tag.userId, tag.slug] });
	}

	const tagRows =
		slugs.length > 0
			? await db
					.select()
					.from(tag)
					.where(and(eq(tag.userId, userId), inArray(tag.slug, slugs)))
			: [];

	await db.delete(artworkTag).where(eq(artworkTag.artworkId, input.artworkId));

	if (tagRows.length === 0) {
		return [];
	}

	await db
		.insert(artworkTag)
		.values(
			tagRows.map((row) => ({
				artworkId: input.artworkId,
				tagId: row.id,
			})),
		)
		.onConflictDoNothing();

	return tagRows;
}

export const tagsRouter = router({
	list: protectedProcedure
		.meta({
			mcp: {
				name: "list_tags",
				title: "List tags",
				description: "List the tags the user has defined.",
				readOnly: true,
			},
		})
		.query(async ({ ctx }) => {
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
		.meta({
			mcp: {
				name: "set_artwork_tags",
				title: "Set artwork tags",
				description:
					"Replace an artwork's tags with the given names (created on demand). Pass an empty array to clear all tags.",
			},
		})
		.input(setArtworkTagsSchema)
		.mutation(({ ctx, input }) =>
			replaceArtworkTags(ctx.session.user.id, input),
		),
});
