/** Mirrors `artworkTypes` in apps/server's gallery-helpers. */
export type ArtworkType = "painting" | "photo" | "sculpture" | "print" | "object" | "other";

export const ARTWORK_TYPES: { value: ArtworkType; label: string }[] = [
  { value: "painting", label: "Painting" },
  { value: "photo", label: "Photo" },
  { value: "sculpture", label: "Sculpture" },
  { value: "print", label: "Print" },
  { value: "object", label: "Object" },
  { value: "other", label: "Other" },
];

export type ArtworkCard = {
  id: string;
  title: string;
  artist: string | null;
  artworkType: string;
  year: string | null;
  rating: number | null;
  assetId: string | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  originalUrl: string | null;
  tags: { id: string; name: string; slug: string }[];
};

export type ActiveGalleryTab = "explore" | "journal" | "reviews" | "connect";

/** What the explore wall shows: single works, or spaces (one-room galleries
 * and multi-room museums together). */
export type ExploreView = "artworks" | "spaces";

export const EXPLORE_VIEWS = ["artworks", "spaces"] as const;

export function isExploreView(value: unknown): value is ExploreView {
  return EXPLORE_VIEWS.includes(value as ExploreView);
}
