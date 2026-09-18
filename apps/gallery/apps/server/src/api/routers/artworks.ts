import { db } from "@aqt/gallery-db";
import {
  artist,
  artwork,
  artworkCustomField,
  artworkTag,
  mediaAsset,
  tag,
} from "@aqt/gallery-db/schema/gallery";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { deleteArtworkCacheFiles, deleteArtworkFiles } from "../../media/delete-files";
import {
  fetchMuseumObject,
  guessArtworkType,
  type MuseumSource,
  parseMuseumUrl,
} from "../../media/museum-import";
import { mediaKey } from "../../media/paths";
import { warmArtworkImages } from "../../media/public-image";
import { mediaStore } from "../../media/store";
import { importMediaFromUrls, uploadErrorResponse } from "../../media/upload";
import { importRateLimiter } from "../../rate-limit";
import { protectedProcedure, router } from "../index";
import { findOrCreateArtistByName } from "./artists";
import { artworkTypes, visibleToUser } from "./gallery-helpers";
import { replaceArtworkTags, setArtworkTagsSchema } from "./tags";

/** First 3–4 digit run in a free-text year ("c. 1920", "1484-1486" → 1920,
 * 1484). Null when there's no parseable year, which excludes a work from a
 * year-range filter. */
function parseYear(year: string | null): number | null {
  if (!year) return null;
  const match = year.match(/\d{3,4}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

/** Midnight UTC after the given date — the exclusive upper bound that makes a
 * date-only `seenTo` include every instant of that day. */
function nextDay(iso: string): Date {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const isoDate = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: 'must be an ISO date like "2024-01-31"',
});

/**
 * Every editable field is optional so a caller can patch a subset (an agent
 * setting only `description` and `funFacts`, say) without touching the rest.
 * A field that is *present and null* clears the column; a field that is
 * *absent* leaves it untouched. The web detail editor always sends the full
 * set, so its behaviour is unchanged.
 */
const artworkDetailSchema = z.object({
  title: z.string().min(1).optional(),
  artist: z.string().nullable().optional(),
  artistId: z.string().nullable().optional(),
  artworkType: z.enum(artworkTypes).optional(),
  year: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Free-text display year, e.g. "1889", "c. 1920", "1484-1486". Stored verbatim — not parsed or validated as a date.',
    ),
  medium: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  // Date-typed column: reject unparseable strings here so the caller gets a
  // clear validation error instead of a cryptic Invalid Date at the DB layer.
  seenAt: z
    .string()
    .refine((value) => !Number.isNaN(new Date(value).getTime()), {
      message:
        'seenAt must be an ISO date like "2024-01-31" (the date you saw the work, not a place).',
    })
    .nullable()
    .optional()
    .describe(
      "The date the owner saw the work, as an ISO date (YYYY-MM-DD). Date-typed, not a place or note. Use year for the creation date.",
    ),
  rating: z.number().int().min(0).max(5).nullable().optional(),
  review: z.string().nullable().optional(),
  thoughts: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  story: z.string().nullable().optional(),
  funFacts: z.array(z.string()).nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
});

const artworkUpdateSchema = artworkDetailSchema.extend({
  artworkId: z.string().min(1),
});

type ArtworkDetailInput = z.infer<typeof artworkDetailSchema>;

const customFieldSchema = z.object({
  label: z.string().min(1),
  value: z.string(),
  position: z
    .number()
    .int()
    .optional()
    .describe("Sort position; defaults to the entry's index in the array."),
});

const enrichItemSchema = artworkDetailSchema.extend({
  artworkId: z.string().min(1),
  tagNames: setArtworkTagsSchema.shape.tagNames.optional(),
  customFields: z.array(customFieldSchema).optional(),
});

/** One `import_artworks_from_urls` item: the image URL to download plus (all
 * optional) the metadata the new artwork should carry. The same fields as
 * `update_artwork`, so an agent can import image + details in one call instead
 * of import → enrich. */
const importItemSchema = artworkDetailSchema.extend({
  url: z.string().url().describe("The image URL to download into the archive."),
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Display title for the new artwork. Defaults to the image filename."),
  tagNames: setArtworkTagsSchema.shape.tagNames.optional(),
  customFields: z.array(customFieldSchema).optional(),
});

type EnrichResult =
  | { artworkId: string; ok: true }
  | { artworkId: string; ok: false; error: string };

/** Maps a (partial) update input to the Drizzle `set` object, including only
 * the keys the caller actually provided. */
function artworkSetValues(input: ArtworkDetailInput): Partial<typeof artwork.$inferInsert> {
  const set: Partial<typeof artwork.$inferInsert> = {};
  if (input.title !== undefined) set.title = input.title;
  if (input.artist !== undefined) set.artist = input.artist;
  if (input.artistId !== undefined) set.artistId = input.artistId;
  if (input.artworkType !== undefined) set.artworkType = input.artworkType;
  if (input.year !== undefined) set.year = input.year;
  if (input.medium !== undefined) set.medium = input.medium;
  if (input.dimensions !== undefined) set.dimensions = input.dimensions;
  if (input.seenAt !== undefined) {
    set.seenAt = input.seenAt ? new Date(input.seenAt) : null;
  }
  if (input.rating !== undefined) set.rating = input.rating;
  if (input.review !== undefined) set.review = input.review;
  if (input.thoughts !== undefined) set.thoughts = input.thoughts;
  if (input.description !== undefined) set.description = input.description;
  if (input.story !== undefined) set.story = input.story;
  if (input.funFacts !== undefined) set.funFacts = input.funFacts;
  if (input.sourceUrl !== undefined) set.sourceUrl = input.sourceUrl;
  return set;
}

/** A linked artist must be one the caller can see — their own or a seeded
 * global artist (`user_id` null). Stops one user pointing an artwork at
 * another user's private artist. */
async function assertArtistLinkable(artistId: string, userId: string) {
  const rows = await db
    .select({ id: artist.id })
    .from(artist)
    .where(and(eq(artist.id, artistId), or(eq(artist.userId, userId), isNull(artist.userId))))
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Artist not found" });
  }
}

/** Remove a freshly-imported artwork (and its files) when a later enrichment
 * step fails, so a half-imported object doesn't leave an orphaned, unenriched
 * draft the user never asked to keep. Mirrors the `purge` mutation. */
async function purgeImportedArtwork(userId: string, artworkId: string) {
  const assets = await db
    .select({
      storagePath: mediaAsset.storagePath,
      thumbnailPath: mediaAsset.thumbnailPath,
    })
    .from(mediaAsset)
    .where(and(eq(mediaAsset.artworkId, artworkId), eq(mediaAsset.userId, userId)));
  const deleted = await db
    .delete(artwork)
    .where(and(eq(artwork.id, artworkId), eq(artwork.userId, userId)))
    .returning({ id: artwork.id });
  if (deleted.length > 0) {
    await deleteArtworkFiles({
      store: mediaStore,
      artworkId,
      assetKeys: assets.flatMap((a) => [mediaKey(a.storagePath), mediaKey(a.thumbnailPath)]),
    });
  }
}

/** Patch an artwork's editable columns. Shared by the `update` mutation and
 * the batch `enrich`, so single-item and batch edits can't diverge. */
async function updateArtwork(userId: string, input: z.infer<typeof artworkUpdateSchema>) {
  if (input.artistId) {
    await assertArtistLinkable(input.artistId, userId);
  }
  const setValues = artworkSetValues(input);
  const where = and(eq(artwork.id, input.artworkId), eq(artwork.userId, userId));

  // Nothing to change (id only) — return the current row instead of
  // asking Drizzle to run an empty `set`, which would throw.
  if (Object.keys(setValues).length === 0) {
    const rows = await db.select().from(artwork).where(where).limit(1);
    if (!rows[0]) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Artwork not found" });
    }
    return rows[0];
  }

  const rows = await db.update(artwork).set(setValues).where(where).returning();

  // A write that matched no owned row is a failure, not a no-op — so an
  // agent calling update_artwork with a wrong id sees an error.
  if (!rows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Artwork not found" });
  }
  return rows[0];
}

/** Replace an artwork's custom label/value rows in array order. Shared by the
 * `setCustomFields` mutation and the batch `enrich`. */
async function replaceCustomFields(
  userId: string,
  artworkId: string,
  fields: z.infer<typeof customFieldSchema>[],
) {
  const ownedRows = await db
    .select({ id: artwork.id })
    .from(artwork)
    .where(and(eq(artwork.id, artworkId), eq(artwork.userId, userId)))
    .limit(1);

  if (!ownedRows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Artwork not found" });
  }

  await db.delete(artworkCustomField).where(eq(artworkCustomField.artworkId, artworkId));

  if (fields.length === 0) {
    return [];
  }

  return db
    .insert(artworkCustomField)
    .values(
      fields.map((field, index) => ({
        id: crypto.randomUUID(),
        artworkId,
        label: field.label,
        value: field.value,
        position: field.position ?? index,
      })),
    )
    .returning();
}

/** Enrichment items are independent, so they run in small parallel batches: a
 * 50-item call isn't ~150 strictly-sequential round trips, and in-flight DB
 * work stays bounded. Order is preserved. */
const ENRICH_CONCURRENCY = 5;

export const artworksRouter = router({
  list: protectedProcedure
    .meta({
      mcp: {
        name: "list_artworks",
        title: "List artworks",
        description:
          "List artworks (newest first by default). scope 'mine' (default) is the user's own archive in any state; scope 'all' adds every published work by anyone, own works first, which is exactly the set the user may hang. Use to find artworkIds before editing or hanging them. Filters combine (AND): query (title/artist substring), artworkType, artistId (a linked artist), ratingMin/ratingMax (0–5 private rating), seenFrom/seenTo (ISO dates the work was seen), and yearFrom/yearTo (creation year parsed from the free-text year). A rating, seen, or year bound excludes works that lack that value; rating and seen are private, so they only ever match the user's own works.",
        readOnly: true,
      },
    })
    .input(
      z
        .object({
          scope: z.enum(["mine", "all"]).default("mine"),
          query: z.string().optional(),
          tagId: z.string().optional(),
          artistId: z.string().optional(),
          artworkType: z.enum(artworkTypes).optional(),
          ratingMin: z.number().int().min(0).max(5).optional(),
          ratingMax: z.number().int().min(0).max(5).optional(),
          seenFrom: isoDate.optional().describe("Earliest seen date, ISO (YYYY-MM-DD)."),
          seenTo: isoDate.optional().describe("Latest seen date, ISO (YYYY-MM-DD)."),
          yearFrom: z.number().int().optional().describe("Earliest creation year, inclusive."),
          yearTo: z.number().int().optional().describe("Latest creation year, inclusive."),
          sort: z.enum(["newest", "oldest", "title", "rating"]).default("newest"),
          // Optional pagination; omitted = the full set. `cursor` is the row
          // offset of the page, named so tRPC infinite queries can drive it.
          // The year-range filter still runs in JS post-fetch, so a page may
          // return fewer than `limit` rows once a year bound is applied.
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const isOwn = eq(artwork.userId, userId);
      const everyone = input?.scope === "all";
      // Rating and seen date are the owner's private annotations, so a bound
      // on them must never match (and thereby reveal) another user's values.
      const ownOnly = (filter: SQL) => (everyone ? and(isOwn, filter) : filter);
      const filters = [
        everyone ? visibleToUser(userId) : isOwn,
        isNull(artwork.deletedAt),
        input?.artworkType ? eq(artwork.artworkType, input.artworkType) : undefined,
        input?.artistId ? eq(artwork.artistId, input.artistId) : undefined,
        input?.ratingMin != null ? ownOnly(gte(artwork.rating, input.ratingMin)) : undefined,
        input?.ratingMax != null ? ownOnly(lte(artwork.rating, input.ratingMax)) : undefined,
        input?.seenFrom ? ownOnly(gte(artwork.seenAt, new Date(input.seenFrom))) : undefined,
        // seenAt is a timestamp; treat a date-only seenTo as inclusive of the
        // whole day by bounding below the next midnight.
        input?.seenTo ? ownOnly(lt(artwork.seenAt, nextDay(input.seenTo))) : undefined,
        input?.query
          ? or(ilike(artwork.title, `%${input.query}%`), ilike(artwork.artist, `%${input.query}%`))
          : undefined,
        // Tag membership pushed into SQL (correlated EXISTS) so the DB returns
        // only matching rows instead of fetching the whole archive and
        // filtering in JS. tag.userId scopes it to the caller's own tags.
        input?.tagId
          ? exists(
              db
                .select({ one: sql`1` })
                .from(artworkTag)
                .innerJoin(tag, eq(tag.id, artworkTag.tagId))
                .where(
                  and(
                    eq(artworkTag.artworkId, artwork.id),
                    eq(tag.id, input.tagId),
                    eq(tag.userId, userId),
                  ),
                ),
            )
          : undefined,
      ].filter((filter) => filter !== undefined);

      // Stable, intuitive ordering: NULL ratings sort last (DESC would float
      // unrated works above 5-star ones), and every sort has archivedAt as a
      // deterministic tiebreaker so equal keys (and any paging) are stable.
      // Across everyone, own works lead like the spaces wall.
      const sortBy =
        input?.sort === "oldest"
          ? [asc(artwork.archivedAt)]
          : input?.sort === "title"
            ? [asc(artwork.title), desc(artwork.archivedAt)]
            : input?.sort === "rating"
              ? [sql`${artwork.rating} desc nulls last`, desc(artwork.archivedAt)]
              : [desc(artwork.archivedAt)];
      const orderBy = everyone ? [desc(isOwn), ...sortBy] : sortBy;

      const rows = await db
        .select({
          id: artwork.id,
          userId: artwork.userId,
          title: artwork.title,
          artist: artwork.artist,
          artworkType: artwork.artworkType,
          year: artwork.year,
          dimensions: artwork.dimensions,
          rating: artwork.rating,
          archivedAt: artwork.archivedAt,
          assetId: mediaAsset.id,
          assetWidth: mediaAsset.width,
          assetHeight: mediaAsset.height,
          mimeType: mediaAsset.mimeType,
          imageUrl: artwork.imageUrl,
          externalThumbUrl: artwork.thumbnailUrl,
          imageWidth: artwork.imageWidth,
          imageHeight: artwork.imageHeight,
        })
        .from(artwork)
        .leftJoin(mediaAsset, eq(mediaAsset.id, artwork.primaryAssetId))
        .where(and(...filters))
        .orderBy(...orderBy)
        .limit(input?.limit ?? Number.MAX_SAFE_INTEGER)
        .offset(input?.cursor ?? 0);

      let scopedRows = rows;

      // Year is free text ("c. 1920", "1484-1486"), so the range filter runs
      // in JS off a parsed leading year rather than in SQL. A work with no
      // parseable year is excluded once a bound is set.
      if (input?.yearFrom != null || input?.yearTo != null) {
        const from = input.yearFrom ?? Number.NEGATIVE_INFINITY;
        const to = input.yearTo ?? Number.POSITIVE_INFINITY;
        scopedRows = scopedRows.filter((row) => {
          const y = parseYear(row.year);
          return y != null && y >= from && y <= to;
        });
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
        .where(and(inArray(artworkTag.artworkId, artworkIds), eq(tag.userId, userId)));

      return scopedRows.map((row) => {
        // An artwork has an image if it was uploaded (a media asset) or
        // carries an external source URL (seeded content). The owner's
        // asset-backed images stream from the owner-auth /media route;
        // external ones, and every other user's published work, go through
        // the public proxy/cache, which also serves the owner's own
        // unpublished artworks. Either way the browser never hotlinks.
        const own = row.userId === userId;
        const hasImage = Boolean(row.assetId || row.imageUrl || row.externalThumbUrl);
        const ownAsset = own && row.assetId;
        return {
          id: row.id,
          isOwn: own,
          title: row.title,
          artist: row.artist,
          artworkType: row.artworkType,
          year: row.year,
          dimensions: row.dimensions,
          rating: own ? row.rating : null,
          archivedAt: row.archivedAt,
          assetId: ownAsset ? row.assetId : null,
          mimeType: ownAsset ? row.mimeType : null,
          width: row.assetWidth ?? row.imageWidth,
          height: row.assetHeight ?? row.imageHeight,
          thumbnailUrl: ownAsset
            ? `/media/${row.assetId}/thumb`
            : hasImage
              ? `/public-image/artwork/${row.id}/thumb`
              : null,
          originalUrl: ownAsset
            ? `/media/${row.assetId}/original`
            : hasImage
              ? `/public-image/artwork/${row.id}/full`
              : null,
          tags: tagRows
            .filter((tagRow) => tagRow.artworkId === row.id)
            .map((tagRow) => ({
              id: tagRow.id,
              name: tagRow.name,
              slug: tagRow.slug,
            })),
        };
      });
    }),

  get: protectedProcedure
    .meta({
      mcp: {
        name: "get_artwork",
        title: "Get artwork",
        description: "Fetch one artwork with all its details, custom fields and tags.",
        readOnly: true,
      },
    })
    .input(z.object({ artworkId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const rows = await db
        .select()
        .from(artwork)
        .where(
          and(
            eq(artwork.id, input.artworkId),
            eq(artwork.userId, userId),
            isNull(artwork.deletedAt),
          ),
        )
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

      // Resolve a single display image the same way `list` does: the
      // uploaded asset when present, else the external source through the
      // proxy (which serves the owner's own unpublished artworks too).
      const primaryAsset = assets[0];
      const hasExternal = Boolean(item.imageUrl || item.thumbnailUrl);
      const image = primaryAsset
        ? {
            thumbnailUrl: `/media/${primaryAsset.id}/thumb`,
            originalUrl: `/media/${primaryAsset.id}/original`,
          }
        : hasExternal
          ? {
              thumbnailUrl: `/public-image/artwork/${item.id}/thumb`,
              originalUrl: `/public-image/artwork/${item.id}/full`,
            }
          : null;

      return {
        artwork: item,
        image,
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
    .meta({
      mcp: {
        name: "update_artwork",
        title: "Update artwork details",
        description:
          "Set any subset of an artwork's details. Omitted fields are left untouched; an explicit null clears a field. See gallery://guide for the field reference and the artworkType enum.",
        idempotent: true,
      },
    })
    .input(artworkUpdateSchema)
    .mutation(({ ctx, input }) => updateArtwork(ctx.session.user.id, input)),

  /** Batch form of `update` + `tags.setArtworkTags` + `setCustomFields`: the
   * one call an agent makes after an import. Items apply independently, so a
   * few bad ids don't sink the rest. */
  enrich: protectedProcedure
    .meta({
      mcp: {
        name: "enrich_artworks",
        title: "Enrich many artworks at once",
        description:
          "Patch details, tags, and custom fields for up to 50 artworks in a single call — the batch form of update_artwork + set_artwork_tags + set_artwork_custom_fields. Use this right after import_artworks_from_urls instead of one update per piece. Per item: any artwork fields to set (same as update_artwork), an optional tagNames array (replaces that artwork's tags), and an optional customFields array (replaces its label/value rows). Items are applied independently — the result lists { artworkId, ok, error } per item, so a few failures don't sink the rest.",
      },
    })
    .input(z.object({ items: z.array(enrichItemSchema).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const applyOne = async (item: z.infer<typeof enrichItemSchema>): Promise<EnrichResult> => {
        const { artworkId, tagNames, customFields, ...fields } = item;
        try {
          if (Object.keys(fields).length > 0) {
            await updateArtwork(userId, { artworkId, ...fields });
          }
          if (tagNames !== undefined) {
            await replaceArtworkTags(userId, { artworkId, tagNames });
          }
          if (customFields !== undefined) {
            await replaceCustomFields(userId, artworkId, customFields);
          }
          return { artworkId, ok: true };
        } catch (error) {
          return {
            artworkId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      };

      const results: EnrichResult[] = [];
      for (let i = 0; i < input.items.length; i += ENRICH_CONCURRENCY) {
        results.push(
          ...(await Promise.all(input.items.slice(i, i + ENRICH_CONCURRENCY).map(applyOne))),
        );
      }
      return { results };
    }),

  /** Soft-delete: hide the artwork from the archive and the public render
   * but keep it (and its files) restorable. `purge` is the irreversible
   * counterpart that frees the storage. */
  delete: protectedProcedure
    .meta({
      mcp: {
        name: "delete_artwork",
        title: "Delete an artwork",
        description:
          "Soft-delete an artwork: it disappears from the archive and from any published exhibition, but is recoverable with restore_artwork until you purge_artwork it. Use this to clean up bad imports.",
        idempotent: true,
      },
    })
    .input(z.object({ artworkId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const updated = await db
        .update(artwork)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(artwork.id, input.artworkId),
            eq(artwork.userId, userId),
            isNull(artwork.deletedAt),
          ),
        )
        .returning({ id: artwork.id });
      // An id the caller doesn't own (or already deleted) is a no-op success
      // so retries stay idempotent.
      return { ok: true, deleted: updated.length > 0 };
    }),

  /** Bring a soft-deleted artwork back into the archive. Its room
   * memberships were preserved, so it reappears wherever it was hung. */
  restore: protectedProcedure
    .meta({
      mcp: {
        name: "restore_artwork",
        title: "Restore a deleted artwork",
        description:
          "Undo a delete_artwork: bring a soft-deleted artwork back into the archive. It reappears in whatever rooms it was hung in.",
        idempotent: true,
      },
    })
    .input(z.object({ artworkId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const updated = await db
        .update(artwork)
        .set({ deletedAt: null })
        .where(and(eq(artwork.id, input.artworkId), eq(artwork.userId, userId)))
        .returning();
      if (!updated[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Artwork not found",
        });
      }
      return updated[0];
    }),

  /** Permanently remove an artwork and its media (files + cascade rows).
   * Irreversible; the placement rows in any room cascade away. */
  purge: protectedProcedure
    .meta({
      mcp: {
        name: "purge_artwork",
        title: "Permanently delete an artwork",
        description:
          "Irreversibly remove an artwork and its image files, and drop it from every room. Cannot be undone — prefer delete_artwork unless the user explicitly wants it gone for good.",
        destructive: true,
        idempotent: true,
      },
    })
    .input(z.object({ artworkId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // Read the asset paths before the FK cascade drops the media_asset
      // rows. Scoped to the owner so this can never reveal another user's
      // paths; the delete below is the authoritative ownership gate.
      const assets = await db
        .select({
          storagePath: mediaAsset.storagePath,
          thumbnailPath: mediaAsset.thumbnailPath,
        })
        .from(mediaAsset)
        .where(and(eq(mediaAsset.artworkId, input.artworkId), eq(mediaAsset.userId, userId)));

      const deleted = await db
        .delete(artwork)
        .where(and(eq(artwork.id, input.artworkId), eq(artwork.userId, userId)))
        .returning({ id: artwork.id });

      // Only unlink files when we actually owned and removed the row.
      if (deleted.length > 0) {
        await deleteArtworkFiles({
          store: mediaStore,
          artworkId: input.artworkId,
          assetKeys: assets.flatMap((a) => [mediaKey(a.storagePath), mediaKey(a.thumbnailPath)]),
        });
      }
      return { ok: true, purged: deleted.length > 0 };
    }),

  /** Choose which uploaded asset is the artwork's hero image (the one the
   * grids and 3D wall show). The asset must belong to this artwork. */
  setPrimaryAsset: protectedProcedure
    .meta({
      mcp: {
        name: "set_primary_asset",
        title: "Set an artwork's primary image",
        description:
          "Choose which of an artwork's uploaded media assets is its hero image — the one shown in the grids and on the 3D wall. The asset must belong to that artwork (see get_artwork → mediaAssets[].id).",
        idempotent: true,
      },
    })
    .input(
      z.object({
        artworkId: z.string().min(1),
        assetId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const owned = await db
        .select({ id: mediaAsset.id })
        .from(mediaAsset)
        .where(
          and(
            eq(mediaAsset.id, input.assetId),
            eq(mediaAsset.artworkId, input.artworkId),
            eq(mediaAsset.userId, userId),
          ),
        )
        .limit(1);
      if (!owned[0]) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Asset does not belong to this artwork",
        });
      }
      const updated = await db
        .update(artwork)
        .set({ primaryAssetId: input.assetId })
        .where(and(eq(artwork.id, input.artworkId), eq(artwork.userId, userId)))
        .returning();
      if (!updated[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Artwork not found",
        });
      }
      // The capped-webp cache is keyed by artwork id, so it still holds the
      // previous asset's pixels — and published works serve it immutable.
      // Purge it here so the new primary asset is re-derived on next request.
      await deleteArtworkCacheFiles({
        store: mediaStore,
        artworkId: input.artworkId,
      });
      void warmArtworkImages({
        store: mediaStore,
        ownerId: userId,
        artworkIds: [input.artworkId],
      });
      return updated[0];
    }),

  bulkUpdate: protectedProcedure
    .input(z.object({ artworks: z.array(artworkUpdateSchema) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Atomic: an unlinkable artist or a failed write on any item rolls back
      // the whole batch rather than leaving it half-applied. The artist
      // visibility check is a read of unrelated rows, so it stays on `db`.
      return db.transaction(async (tx) => {
        const updated = [];
        for (const item of input.artworks) {
          if (item.artistId) {
            await assertArtistLinkable(item.artistId, userId);
          }
          const setValues = artworkSetValues(item);
          if (Object.keys(setValues).length === 0) continue;
          const rows = await tx
            .update(artwork)
            .set(setValues)
            .where(and(eq(artwork.id, item.artworkId), eq(artwork.userId, userId)))
            .returning();
          if (rows[0]) {
            updated.push(rows[0]);
          }
        }
        return updated;
      });
    }),

  /** Import artworks from remote image URLs. Each URL is downloaded once
   * and stored as a media asset (same as an upload) so the gallery never
   * relies on the third-party URL afterwards. */
  importFromUrl: protectedProcedure
    .meta({
      mcp: {
        name: "import_artworks_from_urls",
        title: "Import artworks from URLs",
        description:
          "Download remote image URLs into the user's archive (1–25 at a time). Each image is fetched once and stored locally, becoming a new unpublished artwork. Each item may also carry the same metadata as update_artwork — title, artist, artistId, artworkType, year, medium, dimensions, description, story, funFacts, rating/review/thoughts, seenAt, sourceUrl — plus tagNames and customFields, which are written onto the freshly imported artwork in the same call (so a JSON manifest can be imported without a follow-up enrich step). Returns the new artworkId + title per item; items whose metadata could not be applied are removed and listed in `failed` per item. Metadata-only fields are still optional — import bare URLs and follow up with enrich_artworks if you prefer.",
      },
    })
    .input(z.object({ items: z.array(importItemSchema).min(1).max(25) }))
    .mutation(async ({ ctx, input }) => {
      // Imports fetch arbitrary upstream URLs server-side, so throttle by
      // image count (covers both the HTTP API and the MCP import tool, which
      // share this procedure).
      const limit = importRateLimiter.check(ctx.session.user.id, input.items.length);
      if (!limit.ok) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Import rate limit reached — try again in ${Math.ceil(
            limit.retryAfterMs / 1000,
          )}s.`,
        });
      }

      const result = await importMediaFromUrls({
        items: input.items,
        store: mediaStore,
        userId: ctx.session.user.id,
      });
      if (!result.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: uploadErrorResponse(result.error).body.error,
        });
      }

      const userId = ctx.session.user.id;
      type Outcome =
        | { ok: true; artwork: { artworkId: string; title: string } }
        | { ok: false; url: string; error: string };

      const applyOne = async (
        item: z.infer<typeof importItemSchema>,
        { artworkId, title }: { artworkId: string; title: string },
      ): Promise<Outcome> => {
        const { url, title: _title, tagNames, customFields, ...fields } = item;
        try {
          if (Object.keys(fields).length > 0) {
            await updateArtwork(userId, { artworkId, ...fields });
          }
          if (tagNames !== undefined) {
            await replaceArtworkTags(userId, { artworkId, tagNames });
          }
          if (customFields !== undefined) {
            await replaceCustomFields(userId, artworkId, customFields);
          }
          return { ok: true, artwork: { artworkId, title } };
        } catch (error) {
          // Roll the orphaned draft back so the archive stays clean;
          // mirrors importFromMuseumObject's per-item rollback.
          await purgeImportedArtwork(userId, artworkId).catch(() => {});
          return {
            ok: false,
            url,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      };

      // importMediaFromUrls preserves item order (mapWithConcurrency indexes
      // results, and the stored files keep that order), so uploaded[i] is
      // the artwork for input.items[i]. Batched like enrich, in input order.
      const pairs = result.uploaded.flatMap((uploaded, index) => {
        const item = input.items[index];
        return item ? [{ item, uploaded }] : [];
      });
      const outcomes: Outcome[] = [];
      for (let i = 0; i < pairs.length; i += ENRICH_CONCURRENCY) {
        outcomes.push(
          ...(await Promise.all(
            pairs.slice(i, i + ENRICH_CONCURRENCY).map((p) => applyOne(p.item, p.uploaded)),
          )),
        );
      }

      const imported: Array<{ artworkId: string; title: string }> = [];
      const failed: Array<{ url: string; error: string }> = [];
      for (const outcome of outcomes) {
        if (outcome.ok) {
          imported.push(outcome.artwork);
        } else {
          failed.push({ url: outcome.url, error: outcome.error });
        }
      }

      void warmArtworkImages({
        store: mediaStore,
        ownerId: userId,
        artworkIds: imported.map((u) => u.artworkId),
      });
      return failed.length > 0 ? { imported, failed } : { imported };
    }),

  /** One-call enriched import from a public museum / knowledge API. Fetches
   * the object's metadata (title, artist, year, medium, dimensions,
   * description, credit) from a fixed allowlist of hosts, downloads its image
   * through the same SSRF-guarded importer as importFromUrl, then writes the
   * normalized columns onto the new artwork and (by default) links a
   * structured artist. Items are applied independently. */
  importFromMuseumObject: protectedProcedure
    .meta({
      mcp: {
        name: "import_from_museum_object",
        title: "Import an enriched artwork from a museum / Wikidata object",
        description:
          'One-call enriched import (1–10 objects) from a public collection API: the Met (source "met", numeric objectId), the Art Institute of Chicago ("artic", numeric objectId), or Wikidata ("wikidata", a Q-number). Per item pass { source, objectId } or just a { url } to one of those object pages. Each object\'s title, artist, year, medium, dimensions, description and credit are fetched and written onto a freshly-imported artwork, and its image is downloaded into the archive — so the dimensions become a real-world size in the 3D museum instead of a guessed aspect ratio, and you don\'t have to fill every field by hand. By default it also find-or-creates and links a structured artist (set linkArtist false to skip). Returns { results: [{ ok, source, objectId, artworkId, title, artistId } | { ok:false, ref, error }] } — items apply independently. Follow up with update_artwork only to fill gaps (e.g. a story).',
      },
    })
    .input(
      z.object({
        items: z
          .array(
            z
              .object({
                source: z.enum(["met", "artic", "wikidata"]).optional(),
                objectId: z
                  .string()
                  .min(1)
                  .max(64)
                  .optional()
                  .describe(
                    "The object id within the source: Met objectID, Art Institute id, or Wikidata Q-number. Omit if you pass url.",
                  ),
                url: z
                  .string()
                  .url()
                  .optional()
                  .describe(
                    "An object page URL on metmuseum.org, artic.edu, or wikidata.org — parsed into source + objectId. Use instead of source/objectId.",
                  ),
              })
              .refine((v) => Boolean(v.url) || Boolean(v.source && v.objectId), {
                message: "Provide either url, or both source and objectId",
              }),
          )
          .min(1)
          .max(10),
        linkArtist: z
          .boolean()
          .default(true)
          .describe(
            "Find-or-create and link a structured artist from the object's creator (default true).",
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // Each item downloads one image, so charge the import budget per item.
      const limit = importRateLimiter.check(userId, input.items.length);
      if (!limit.ok) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Import rate limit reached — try again in ${Math.ceil(
            limit.retryAfterMs / 1000,
          )}s.`,
        });
      }

      type ImportResult =
        | {
            ok: true;
            source: MuseumSource;
            objectId: string;
            artworkId: string;
            title: string;
            artistId: string | null;
          }
        | { ok: false; ref: string; error: string };
      const results: ImportResult[] = [];

      for (const item of input.items) {
        const resolved = item.url
          ? parseMuseumUrl(item.url)
          : {
              source: item.source as MuseumSource,
              objectId: item.objectId as string,
            };
        const ref = item.url ?? `${item.source}:${item.objectId}`;
        // Tracks the artwork created mid-item so a failure during enrichment
        // (after the image import succeeds) can roll it back instead of
        // leaving an orphaned draft.
        let createdArtworkId: string | null = null;
        try {
          if (!resolved) {
            throw new Error("Unrecognized museum URL");
          }
          const obj = await fetchMuseumObject(resolved.source, resolved.objectId);
          if (!obj.imageUrl) {
            throw new Error("No public image is available for this object");
          }

          const imported = await importMediaFromUrls({
            items: [{ url: obj.imageUrl, title: obj.title }],
            store: mediaStore,
            userId,
          });
          if (!imported.ok) {
            throw new Error(uploadErrorResponse(imported.error).body.error);
          }
          const artworkId = imported.uploaded[0]?.artworkId;
          if (!artworkId) {
            throw new Error("Import produced no artwork");
          }
          createdArtworkId = artworkId;

          // Enrich the freshly-imported draft. The importer already stored
          // the title and recorded the image URL as the source; overwrite
          // the source with the richer object page.
          await db
            .update(artwork)
            .set({
              title: obj.title,
              artist: obj.artistName,
              year: obj.year,
              medium: obj.medium,
              dimensions: obj.dimensions,
              description: obj.description,
              artworkType: guessArtworkType(obj.medium),
              sourceUrl: obj.sourceUrl,
            })
            .where(and(eq(artwork.id, artworkId), eq(artwork.userId, userId)));

          if (obj.credit) {
            await db.insert(artworkCustomField).values({
              id: crypto.randomUUID(),
              artworkId,
              label: "Credit",
              value: obj.credit,
              position: 0,
            });
          }

          let artistId: string | null = null;
          if (input.linkArtist && obj.artist) {
            const linked = await findOrCreateArtistByName(userId, obj.artist);
            await db
              .update(artwork)
              .set({ artistId: linked.id })
              .where(and(eq(artwork.id, artworkId), eq(artwork.userId, userId)));
            artistId = linked.id;
          }

          results.push({
            ok: true,
            source: resolved.source,
            objectId: resolved.objectId,
            artworkId,
            title: obj.title,
            artistId,
          });
        } catch (error) {
          // Roll back a partial import so a failed item leaves no orphan.
          if (createdArtworkId) {
            await purgeImportedArtwork(userId, createdArtworkId).catch(() => {});
          }
          results.push({
            ok: false,
            ref,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      void warmArtworkImages({
        store: mediaStore,
        ownerId: userId,
        artworkIds: results.flatMap((r) => (r.ok ? [r.artworkId] : [])),
      });
      return { results };
    }),

  createDraftFromUpload: protectedProcedure
    .input(z.object({ title: z.string().min(1), assetId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // The asset must belong to the caller — otherwise a draft could point
      // at another user's asset and leak its metadata (dimensions, mime) into
      // this user's list/get responses. Mirrors setPrimaryAsset's check.
      const owned = await db
        .select({ id: mediaAsset.id })
        .from(mediaAsset)
        .where(and(eq(mediaAsset.id, input.assetId), eq(mediaAsset.userId, userId)))
        .limit(1);
      if (!owned[0]) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Asset does not belong to this user",
        });
      }
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
      void warmArtworkImages({
        store: mediaStore,
        ownerId: userId,
        artworkIds: [id],
      });
      return rows[0];
    }),

  setCustomFields: protectedProcedure
    .meta({
      mcp: {
        name: "set_artwork_custom_fields",
        title: "Set artwork custom fields",
        description:
          "Replace an artwork's custom label/value rows (e.g. Collection → MoMA). Order follows the array. Pass an empty array to clear them.",
      },
    })
    .input(
      z.object({
        artworkId: z.string().min(1),
        fields: z.array(customFieldSchema),
      }),
    )
    .mutation(({ ctx, input }) =>
      replaceCustomFields(ctx.session.user.id, input.artworkId, input.fields),
    ),
});
