import { db } from "@aqt-gallery/db";
import { artist } from "@aqt-gallery/db/schema/gallery";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router } from "../index";
import { slugify } from "./gallery-helpers";

/** artist.slug is globally unique; suffix on collision (mirrors the gallery
 * slug helper) so two users — or a user and a seeded artist — can share a
 * name without clashing. */
async function uniqueArtistSlug(name: string) {
	const base = slugify(name) || "artist";
	for (let i = 0; i < 50; i++) {
		const candidate = i === 0 ? base : `${base}-${i + 1}`;
		const existing = await db
			.select({ id: artist.id })
			.from(artist)
			.where(eq(artist.slug, candidate))
			.limit(1);
		if (!existing[0]) {
			return candidate;
		}
	}
	return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

const artistInput = {
	name: z.string().min(1).max(160),
	bio: z.string().max(4000).nullable().optional(),
	birthYear: z.number().int().min(-5000).max(3000).nullable().optional(),
	deathYear: z.number().int().min(-5000).max(3000).nullable().optional(),
	nationality: z.string().max(120).nullable().optional(),
	portraitUrl: z.string().url().nullable().optional(),
};

export const artistsRouter = router({
	/** The caller's own artists plus seeded/global reference artists
	 * (`user_id` null), which every user can read and link to. */
	list: protectedProcedure.query(async ({ ctx }) => {
		const userId = ctx.session.user.id;
		return db
			.select()
			.from(artist)
			.where(or(eq(artist.userId, userId), isNull(artist.userId)))
			.orderBy(asc(artist.name));
	}),

	create: protectedProcedure
		.input(z.object(artistInput))
		.mutation(async ({ ctx, input }) => {
			const slug = await uniqueArtistSlug(input.name);
			const rows = await db
				.insert(artist)
				.values({
					id: crypto.randomUUID(),
					userId: ctx.session.user.id,
					slug,
					name: input.name,
					bio: input.bio ?? null,
					birthYear: input.birthYear ?? null,
					deathYear: input.deathYear ?? null,
					nationality: input.nationality ?? null,
					portraitUrl: input.portraitUrl ?? null,
				})
				.returning();
			return rows[0];
		}),

	update: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				name: z.string().min(1).max(160).optional(),
				bio: z.string().max(4000).nullable().optional(),
				birthYear: z.number().int().min(-5000).max(3000).nullable().optional(),
				deathYear: z.number().int().min(-5000).max(3000).nullable().optional(),
				nationality: z.string().max(120).nullable().optional(),
				portraitUrl: z.string().url().nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// The slug is deliberately left untouched on rename so existing links
			// stay valid.
			const set: Partial<typeof artist.$inferInsert> = {};
			if (input.name !== undefined) set.name = input.name;
			if (input.bio !== undefined) set.bio = input.bio;
			if (input.birthYear !== undefined) set.birthYear = input.birthYear;
			if (input.deathYear !== undefined) set.deathYear = input.deathYear;
			if (input.nationality !== undefined) set.nationality = input.nationality;
			if (input.portraitUrl !== undefined) set.portraitUrl = input.portraitUrl;

			// Only the owner can edit; seeded/global artists (user_id null) are
			// read-only and never match this guard.
			const where = and(
				eq(artist.id, input.id),
				eq(artist.userId, ctx.session.user.id),
			);
			if (Object.keys(set).length === 0) {
				const rows = await db.select().from(artist).where(where).limit(1);
				if (!rows[0]) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Artist not found",
					});
				}
				return rows[0];
			}
			const rows = await db.update(artist).set(set).where(where).returning();
			if (!rows[0]) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Artist not found" });
			}
			return rows[0];
		}),

	delete: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// artwork.artistId is ON DELETE SET NULL, so deleting unlinks any of
			// the caller's artworks automatically.
			const rows = await db
				.delete(artist)
				.where(
					and(eq(artist.id, input.id), eq(artist.userId, ctx.session.user.id)),
				)
				.returning({ id: artist.id });
			if (!rows[0]) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Artist not found" });
			}
			return { ok: true };
		}),
});
