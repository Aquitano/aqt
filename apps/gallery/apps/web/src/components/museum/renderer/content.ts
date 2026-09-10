import {
  buildWorldLayout,
  type WallId,
  type WorldInput,
  type WorldLayout,
} from "@aqt/gallery-layout";

import type { ArtworkData, GalleryContent } from "../types";

/** Image URL ladder for one artwork, smallest first. `mid` (≤1024px) is what a
 * nearby painting shows; `full` (≤2048px) is reserved for hover and inspect. */
export type ImageLadder = {
  thumb: string | null;
  mid: string | null;
  full: string | null;
};

export function imageLadder(artwork: ArtworkData): ImageLadder {
  const full = artwork.imageUrl ?? null;
  return {
    thumb: artwork.thumbnailUrl ?? full,
    mid: artwork.midUrl ?? full,
    full,
  };
}

/** Everything the renderer derives once per gallery payload. */
export type MuseumWorld = {
  world: WorldLayout;
  artworkById: Map<string, ArtworkData>;
};

function toWorldInput(content: GalleryContent): WorldInput {
  return {
    rooms: content.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      description: room.description,
      layout: room.layout,
      artworks: room.artworks.map((a) => ({
        id: a.id,
        dimensions: a.dimensions,
        imageWidth: a.imageWidth,
        imageHeight: a.imageHeight,
        wall: (a.placement?.wall as WallId | null | undefined) ?? null,
        wallOffset: a.placement?.wallOffset ?? null,
        scale: a.placement?.scale ?? null,
      })),
    })),
  };
}

export function buildMuseumWorld(content: GalleryContent): MuseumWorld {
  const artworkById = new Map<string, ArtworkData>();
  for (const room of content.rooms) {
    for (const art of room.artworks) artworkById.set(art.id, art);
  }
  return { world: buildWorldLayout(toWorldInput(content)), artworkById };
}
