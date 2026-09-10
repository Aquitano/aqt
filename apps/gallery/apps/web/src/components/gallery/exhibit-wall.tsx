import { Button } from "@aqt/gallery-ui/components/button";
import { Link } from "@tanstack/react-router";
import { Footprints, Pencil } from "lucide-react";

import { type ExhibitionKind, kindLabel } from "@/components/museum/types";

import { ExhibitTile, type ExhibitTileArtwork } from "./artwork-tile";
import { MasonryWall } from "./masonry-wall";

/** The slice of `exhibitions.bySlug` the 2D wall renders; harness fixtures
 * satisfy it too. */
export type ExhibitWallData = {
  id: string;
  slug: string;
  kind: ExhibitionKind;
  name: string;
  tagline: string | null;
  description: string | null;
  isPublished: boolean;
  isOwner: boolean;
  rooms: {
    id: string;
    name: string;
    description: string | null;
    artworks: ExhibitTileArtwork[];
  }[];
};

export function ExhibitWall({
  exhibition,
  selectedArtworkId,
}: {
  exhibition: ExhibitWallData;
  selectedArtworkId?: string;
}) {
  const { slug } = exhibition;
  const multiRoom = exhibition.rooms.length > 1;
  const artworkCount = exhibition.rooms.reduce((total, room) => total + room.artworks.length, 0);
  const facts = [
    multiRoom ? "Museum" : kindLabel(exhibition.kind),
    multiRoom ? `${exhibition.rooms.length} rooms` : null,
    `${artworkCount} ${artworkCount === 1 ? "work" : "works"}`,
    exhibition.isPublished ? null : "Draft, only you can see this",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <section className="mx-auto max-w-[1480px] pt-10 pb-6">
        <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{facts}</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
              {exhibition.name}
            </h1>
            {exhibition.tagline ? (
              <p className="mt-3 text-[17px] text-muted-foreground">{exhibition.tagline}</p>
            ) : null}
            {exhibition.description ? (
              <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-muted-foreground">
                {exhibition.description}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {exhibition.isOwner ? (
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <Link to="/exhibitions/$exhibitionId" params={{ exhibitionId: exhibition.id }} />
                }
              >
                <Pencil />
                Edit
              </Button>
            ) : null}
            <Button nativeButton={false} render={<Link to="/museum/$slug" params={{ slug }} />}>
              <Footprints />
              Walk in 3D
            </Button>
          </div>
        </div>
      </section>
      <div className="mx-auto grid max-w-[1480px] gap-16 pt-4">
        {exhibition.rooms.map((room, roomIndex) => (
          <section key={room.id} id={`room-${room.id}`} className="scroll-mt-24">
            {multiRoom || room.description ? (
              <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="text-2xl font-semibold tracking-[-0.02em]">
                  {multiRoom ? `${roomIndex + 1}. ` : ""}
                  {room.name}
                </h2>
                {room.description ? (
                  <p className="max-w-prose text-sm text-muted-foreground">{room.description}</p>
                ) : null}
              </div>
            ) : null}
            <MasonryWall>
              {room.artworks.map((artwork, index) => (
                <ExhibitTile
                  key={artwork.id}
                  slug={slug}
                  artwork={artwork}
                  index={roomIndex === 0 ? index : index + 6}
                  highlighted={selectedArtworkId === artwork.id}
                />
              ))}
            </MasonryWall>
          </section>
        ))}
      </div>
    </>
  );
}
