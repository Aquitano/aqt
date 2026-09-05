/** Mirrors `artworkTypes` in apps/server's gallery-helpers. */
export const ARTWORK_TYPES = [
  "painting",
  "photo",
  "sculpture",
  "print",
  "object",
  "other",
] as const;

export type ArtworkType = (typeof ARTWORK_TYPES)[number];

export function isArtworkType(value: string): value is ArtworkType {
  return ARTWORK_TYPES.some((type) => type === value);
}

export type ArtworkCard = {
  id: string;
  title: string;
  artist: string | null;
  artworkType: string;
  rating: number | null;
  assetId: string | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  originalUrl: string | null;
  tags: { id: string; name: string; slug: string }[];
};

export type ActiveGalleryTab = "archive" | "galleries" | "museums" | "reviews" | "connect";
