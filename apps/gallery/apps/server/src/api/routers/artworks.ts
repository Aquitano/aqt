import path from "node:path";

import { db } from "@aqt/gallery-db";
import {
  artist,
  artwork,
  artworkCustomField,
  artworkTag,
  mediaAsset,
  tag,
} from "@aqt/gallery-db/schema/gallery";
import { env } from "@aqt/gallery-env/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";

import { deleteArtworkFiles } from "../../media/delete-files";
import { importMediaFromUrls, uploadErrorResponse } from "../../media/upload";
import { importRateLimiter } from "../../rate-limit";
import { protectedProcedure, router } from "../index";
import { artworkTypes } from "./gallery-helpers";

/**
 * Every editable field is optional so a caller can patch a subset (an agent
 * setting only `description` and `funFacts`, say) without touching the rest.
 * A field that is *present and null* clears the column; a field that is
 * *absent* leaves it untouched. The web detail editor always sends the full
 * set, so its behaviour is unchanged.
 */
const artworkUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  artist: z.string().nullable().optional(),
  artistId: z.string().nullable().optional(),
  artworkType: z.enum(artworkTypes).optional(),
  year: z.string().nullable().optional(),
  medium: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  seenAt: z.string().nullable().optional(),
  rating: z.number().int().min(0).max(5).nullable().optional(),
  review: z.string().nullable().optional(),
  thoughts: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  story: z.string().nullable().optional(),
  funFacts: z.array(z.string()).nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
});

type ArtworkUpdateInput = z.infer<typeof artworkUpdateSchema>;

/** Maps a (partial) update input to the Drizzle `set` object, including only
 * the keys the caller actually provided. */
function artworkSetValues(input: ArtworkUpdateInput): Partial<typeof artwork.$inferInsert> {
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

export const artworksRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          query: z.string().optional(),
          tagId: z.string().optional(),
          artworkType: z.enum(artworkTypes).optional(),
          sort: z.enum(["newest", "oldest", "title", "rating"]).default("newest"),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const filters = [
        eq(artwork.userId, userId),
        input?.artworkType ? eq(artwork.artworkType, input.artworkType) : undefined,
        input?.query
          ? or(ilike(artwork.title, `%${input.query}%`), ilike(artwork.artist, `%${input.query}%`))
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

      return scopedRows.map((row) => {
        // An artwork has an image if it was uploaded (a media asset) or
        // carries an external source URL (seeded content). Asset-backed
        // images stream from the owner-auth /media route; external ones
        // go through the proxy/cache, which also serves the owner's own
        // unpublished artworks. Either way the browser never hotlinks.
        const hasExternal = Boolean(row.imageUrl || row.externalThumbUrl);
        return {
          id: row.id,
          title: row.title,
          artist: row.artist,
          artworkType: row.artworkType,
          rating: row.rating,
          archivedAt: row.archivedAt,
          assetId: row.assetId,
          mimeType: row.mimeType,
          width: row.assetWidth ?? row.imageWidth,
          height: row.assetHeight ?? row.imageHeight,
          thumbnailUrl: row.assetId
            ? `/media/${row.assetId}/thumb`
            : hasExternal
              ? `/public-image/artwork/${row.id}/thumb`
              : null,
          originalUrl: row.assetId
            ? `/media/${row.assetId}/original`
            : hasExternal
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

  update: protectedProcedure.input(artworkUpdateSchema).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    if (input.artistId) {
      await assertArtistLinkable(input.artistId, userId);
    }
    const setValues = artworkSetValues(input);
    const where = and(eq(artwork.id, input.id), eq(artwork.userId, userId));

    // Nothing to change (id only) — return the current row instead of
    // asking Drizzle to run an empty `set`, which would throw.
    if (Object.keys(setValues).length === 0) {
      const rows = await db.select().from(artwork).where(where).limit(1);
      if (!rows[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Artwork not found",
        });
      }
      return rows[0];
    }

    const rows = await db.update(artwork).set(setValues).where(where).returning();

    // A write that matched no owned row is a failure, not a no-op — so an
    // agent calling update_artwork with a wrong id sees an error.
    if (!rows[0]) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Artwork not found",
      });
    }
    return rows[0];
  }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
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
        .where(and(eq(mediaAsset.artworkId, input.id), eq(mediaAsset.userId, userId)));

      const deleted = await db
        .delete(artwork)
        .where(and(eq(artwork.id, input.id), eq(artwork.userId, userId)))
        .returning({ id: artwork.id });

      // Only unlink files when we actually owned and removed the row.
      if (deleted.length > 0) {
        await deleteArtworkFiles({
          uploadRoot: path.resolve(env.UPLOAD_DIR),
          artworkId: input.id,
          assetFiles: assets.flatMap((a) => [a.storagePath, a.thumbnailPath]),
        });
      }
      return { ok: true };
    }),

  bulkUpdate: protectedProcedure
    .input(z.object({ artworks: z.array(artworkUpdateSchema) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const updated = [];

      for (const item of input.artworks) {
        if (item.artistId) {
          await assertArtistLinkable(item.artistId, userId);
        }
        const setValues = artworkSetValues(item);
        if (Object.keys(setValues).length === 0) continue;
        const rows = await db
          .update(artwork)
          .set(setValues)
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
        .where(and(eq(artwork.id, input.artworkId), eq(artwork.userId, ctx.session.user.id)))
        .limit(1);

      if (!ownedRows[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Artwork not found",
        });
      }

      await db.delete(artworkCustomField).where(eq(artworkCustomField.artworkId, input.artworkId));

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
