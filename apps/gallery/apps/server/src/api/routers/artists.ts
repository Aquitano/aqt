import { db } from "@aqt-gallery/db";
import { artist, artwork } from "@aqt-gallery/db/schema/gallery";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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

/** Insert an artist, retrying with a fresh slug suffix on a unique-slug
 * collision. uniqueArtistSlug's select can race a concurrent insert that grabs
 * the same candidate; because slug is globally unique but artists are
 * per-user, re-selecting the conflicting row could return a *different* user's
 * artist, so we re-derive a new suffix and retry instead. */
async function createArtistWithUniqueSlug(values: {
	userId: string;
	name: string;
	bio: string | null;
	birthYear: number | null;
	deathYear: number | null;
	nationality: string | null;
	portraitUrl: string | null;
}): Promise<typeof artist.$inferSelect> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const slug = await uniqueArtistSlug(values.name);
		const created = await db
			.insert(artist)
			.values({ id: crypto.randomUUID(), slug, ...values })
			.onConflictDoNothing({ target: artist.slug })
			.returning();
		if (created[0]) {
			return created[0];
		}
	}
	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: "Failed to create artist",
	});
}

const artistInput = {
	name: z.string().min(1).max(160),
	bio: z.string().max(4000).nullable().optional(),
	birthYear: z.number().int().min(-5000).max(3000).nullable().optional(),
	deathYear: z.number().int().min(-5000).max(3000).nullable().optional(),
	nationality: z.string().max(120).nullable().optional(),
	portraitUrl: z.string().url().nullable().optional(),
};

/** Find-or-create an artist by name for a user: reuse one of the caller's own
 * matching artists first, then a seeded reference artist (user_id null), and
 * only create a new one (with whatever details are supplied) when none match.
 * Shared by linkByName and the museum-object import so attribution never
 * duplicates an existing artist. */
export async function findOrCreateArtistByName(
	userId: string,
	details: {
		name: string;
		bio?: string | null;
		birthYear?: number | null;
		deathYear?: number | null;
		nationality?: string | null;
		portraitUrl?: string | null;
	},
): Promise<typeof artist.$inferSelect> {
	// Case-insensitive EXACT match (lower() both sides) — not ILIKE, whose
	// pattern metacharacters (% _) would let an upstream name like "100%" or
	// "Anne_Marie" match the wrong artist. Scoped to the caller's own artists
	// plus seeded references.
	const matches = await db
		.select()
		.from(artist)
		.where(
			and(
				sql`lower(${artist.name}) = lower(${details.name})`,
				or(eq(artist.userId, userId), isNull(artist.userId)),
			),
		);
	const existing = matches.find((row) => row.userId === userId) ?? matches[0];
	if (existing) {
		return existing;
	}

	return createArtistWithUniqueSlug({
		userId,
		name: details.name,
		bio: details.bio ?? null,
		birthYear: details.birthYear ?? null,
		deathYear: details.deathYear ?? null,
		nationality: details.nationality ?? null,
		portraitUrl: details.portraitUrl ?? null,
	});
}

export const artistsRouter = router({
	/** The caller's own artists plus seeded/global reference artists
	 * (`user_id` null), which every user can read and link to. */
	list: protectedProcedure
		.meta({
			mcp: {
				name: "list_artists",
				title: "List artists",
				description:
					"List artists you can link to a work — your own plus built-in reference artists. Use to reuse an existing artistId instead of creating duplicates.",
				readOnly: true,
			},
		})
		.query(async ({ ctx }) => {
			const userId = ctx.session.user.id;
			return db
				.select()
				.from(artist)
				.where(or(eq(artist.userId, userId), isNull(artist.userId)))
				.orderBy(asc(artist.name));
		}),

	create: protectedProcedure
		.meta({
			mcp: {
				name: "create_artist",
				title: "Create artist",
				description:
					"Create a reusable artist (name + optional bio, dates, nationality, portrait) without linking it to anything. To attribute works, prefer link_artist, which find-or-creates by name and links in one step. Returns the new artist incl. id.",
			},
		})
		.input(z.object(artistInput))
		.mutation(async ({ ctx, input }) => {
			return createArtistWithUniqueSlug({
				userId: ctx.session.user.id,
				name: input.name,
				bio: input.bio ?? null,
				birthYear: input.birthYear ?? null,
				deathYear: input.deathYear ?? null,
				nationality: input.nationality ?? null,
				portraitUrl: input.portraitUrl ?? null,
			});
		}),

	/** Find-or-create an artist by name and link it to a batch of the caller's
	 * artworks in one shot. Collapses the list_artists → create → per-artwork
	 * update_artwork dance, and reusing by name keeps repeated calls from piling
	 * up duplicate artists. */
	linkByName: protectedProcedure
		.meta({
			mcp: {
				name: "link_artist",
				title: "Link an artist to artworks",
				description:
					"The one-step way to attribute works: find-or-create an artist by name and link it to one or more artworks at once. Reuses an existing artist of the same name (your own or a built-in reference artist) instead of duplicating, and only creates one — with any bio/dates you pass — when none matches. Pass every artworkId by the same creator to attribute them together. Prefer this over create_artist + update_artwork.artistId. To unlink, call update_artwork with artistId: null.",
				idempotent: true,
			},
		})
		.input(
			z.object({
				artworkIds: z.array(z.string().min(1)).min(1).max(50),
				...artistInput,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const artworkIds = [...new Set(input.artworkIds)];

			// Every target must be the caller's own artwork; surface unknown ids
			// rather than silently linking a subset.
			const owned = await db
				.select({ id: artwork.id })
				.from(artwork)
				.where(
					and(eq(artwork.userId, userId), inArray(artwork.id, artworkIds)),
				);
			const ownedIds = new Set(owned.map((row) => row.id));
			const missing = artworkIds.filter((id) => !ownedIds.has(id));
			if (missing.length > 0) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `Artwork not found: ${missing.join(", ")}`,
				});
			}

			const target = await findOrCreateArtistByName(userId, input);

			await db
				.update(artwork)
				.set({ artistId: target.id })
				.where(
					and(eq(artwork.userId, userId), inArray(artwork.id, artworkIds)),
				);

			return { artist: target, linkedArtworkIds: artworkIds };
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
