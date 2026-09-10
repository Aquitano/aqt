import type { AppRouter } from "@aqt/gallery-server/api/routers/index";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type LobbyExhibition = RouterOutputs["exhibitions"]["lobby"]["exhibitions"][number];

/** The renderer payload for one exhibition. `journal.collections.exhibit`
 * returns the same shape, so private collections reuse every view. */
export type ExhibitionPayload = NonNullable<RouterOutputs["exhibitions"]["bySlug"]>;

export type ExhibitionKind = ExhibitionPayload["kind"];
/** The kinds a curator picks from; `personal` is the journal's private
 * collection and never reaches the studio or the lobby. */
export type CuratedKind = Exclude<ExhibitionKind, "personal">;

export const KIND_LABEL = {
  exhibition: "Exhibition",
  artist_collection: "Artist collection",
  collection: "Collection",
  custom: "Custom",
} satisfies Record<CuratedKind, string>;

export function kindLabel(kind: ExhibitionKind) {
  return kind === "personal" ? "Private collection" : KIND_LABEL[kind];
}

export type GalleryTheme = ExhibitionPayload["theme"];
export type ArtworkData = ExhibitionPayload["rooms"][number]["artworks"][number];

/** Normalized shape the 3D renderer consumes. */
export type GalleryContent = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  theme: GalleryTheme;
  rooms: {
    id: string;
    name: string;
    description: string | null;
    layout: { width?: number; depth?: number; height?: number } | null;
    artworks: ArtworkData[];
  }[];
};

export function exhibitionToContent(e: ExhibitionPayload): GalleryContent {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    tagline: e.tagline,
    description: e.description,
    theme: e.theme,
    rooms: e.rooms,
  };
}
