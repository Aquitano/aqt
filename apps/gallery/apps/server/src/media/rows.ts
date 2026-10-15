import { db } from "@aqt/gallery-db";
import { exhibition, placement, room } from "@aqt/gallery-db/schema/exhibition";
import { artwork, mediaAsset } from "@aqt/gallery-db/schema/gallery";
import { asc, eq, inArray } from "drizzle-orm";

/** The database reads behind public images and share cards. The media modules
 * take these as a parameter instead of importing `db`, so tests can pass rows
 * without a Postgres connection. */
export const mediaRows = {
  async artwork(id: string) {
    const [row] = await db
      .select({
        imageUrl: artwork.imageUrl,
        thumbnailUrl: artwork.thumbnailUrl,
        isPublished: artwork.isPublished,
        userId: artwork.userId,
        primaryAssetId: artwork.primaryAssetId,
      })
      .from(artwork)
      .where(eq(artwork.id, id))
      .limit(1);
    return row;
  },

  async mediaAsset(id: string) {
    const [row] = await db
      .select({
        storagePath: mediaAsset.storagePath,
        thumbnailPath: mediaAsset.thumbnailPath,
        mimeType: mediaAsset.mimeType,
      })
      .from(mediaAsset)
      .where(eq(mediaAsset.id, id))
      .limit(1);
    return row;
  },

  async exhibitionCover(id: string) {
    const [row] = await db
      .select({
        coverImageUrl: exhibition.coverImageUrl,
        isPublished: exhibition.isPublished,
        createdBy: exhibition.createdBy,
      })
      .from(exhibition)
      .where(eq(exhibition.id, id))
      .limit(1);
    return row;
  },

  async exhibitionBySlug(slug: string) {
    const [row] = await db
      .select({
        id: exhibition.id,
        kind: exhibition.kind,
        name: exhibition.name,
        tagline: exhibition.tagline,
        description: exhibition.description,
        theme: exhibition.theme,
        coverImageUrl: exhibition.coverImageUrl,
        coverArtworkId: exhibition.coverArtworkId,
        isPublished: exhibition.isPublished,
      })
      .from(exhibition)
      .where(eq(exhibition.slug, slug))
      .limit(1);
    return row;
  },

  async roomIds(exhibitionId: string) {
    const rooms = await db
      .select({ id: room.id })
      .from(room)
      .where(eq(room.exhibitionId, exhibitionId))
      .orderBy(asc(room.sortOrder));
    return rooms.map((r) => r.id);
  },

  async placedArtworkIds(roomIds: readonly string[]) {
    if (roomIds.length === 0) return [];
    const placements = await db
      .select({ artworkId: placement.artworkId })
      .from(placement)
      .where(inArray(placement.roomId, [...roomIds]))
      .orderBy(asc(placement.position));
    return placements.map((p) => p.artworkId);
  },
};

export type MediaRows = typeof mediaRows;
export type ImageRows = Pick<MediaRows, "artwork" | "mediaAsset" | "exhibitionCover">;
