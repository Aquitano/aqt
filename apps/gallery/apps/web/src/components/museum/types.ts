import type { AppRouter } from "@aqt/gallery-server/api/routers/index";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type LobbyData = RouterOutputs["museum"]["lobby"];
export type LobbyMuseum = LobbyData["museums"][number];
export type LobbyGroup = LobbyData["groups"][number];

export type MuseumPayload = NonNullable<RouterOutputs["museum"]["museum"]>;
export type GroupPayload = NonNullable<RouterOutputs["museum"]["group"]>;

export type GalleryTheme = MuseumPayload["theme"];
export type ArtworkData = MuseumPayload["rooms"][number]["artworks"][number];

/** Normalized shape the 3D renderer consumes — museums and groups both
 * reduce to this, so the gallery never cares which one it came from. */
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

export function museumToContent(m: MuseumPayload): GalleryContent {
  return {
    id: m.id,
    slug: m.slug,
    name: m.name,
    tagline: m.tagline,
    description: m.description,
    theme: m.theme,
    rooms: m.rooms,
  };
}

export function groupToContent(g: GroupPayload): GalleryContent {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    tagline: g.tagline,
    description: g.description,
    theme: g.theme,
    rooms: g.rooms,
  };
}
