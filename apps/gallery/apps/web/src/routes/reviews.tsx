import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";

import {
  ArchiveControls,
  type ArchiveFilterId,
  type ArchiveSort,
} from "@/components/gallery/archive-controls";
import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { WallEmptyState } from "@/components/gallery/masonry-wall";
import type { ArtworkType } from "@/components/gallery/types";
import { getUser } from "@/functions/get-user";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/reviews")({
  component: RouteComponent,
  beforeLoad: async () => {
    const session = await getUser();
    return { session };
  },
  loader: async ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/login" });
    }
  },
});

function RouteComponent() {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [sort, setSort] = useState<ArchiveSort>("rating");
  const [artworkType, setArtworkType] = useState<ArtworkType | "all">("all");
  const [tagId, setTagId] = useState<ArchiveFilterId>("all");
  const [artistId, setArtistId] = useState<ArchiveFilterId>("all");
  // Filter to rated works on the server (ratingMin) instead of fetching the
  // whole archive and dropping unrated rows in the browser.
  const artworks = useQuery({
    ...trpc.artworks.list.queryOptions({
      query: debouncedSearch,
      sort,
      ratingMin: 1,
      artworkType: artworkType === "all" ? undefined : artworkType,
      tagId: tagId === "all" ? undefined : tagId,
      artistId: artistId === "all" ? undefined : artistId,
    }),
    placeholderData: keepPreviousData,
  });
  const reviewed = artworks.data ?? [];

  return (
    <CosmosShell active="reviews" search={search} onSearch={setSearch}>
      <div className="mx-auto w-full max-w-[1120px] pt-6">
        <div className="mb-6">
          <p className="text-xs font-medium text-muted-foreground">Seen and scored</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.03em]">Reviews</h1>
        </div>
        <ArchiveControls
          sort={sort}
          onSort={setSort}
          artworkType={artworkType}
          onArtworkType={setArtworkType}
          tagId={tagId}
          onTagId={setTagId}
          artistId={artistId}
          onArtistId={setArtistId}
          count={reviewed.length}
        />
        {reviewed.length === 0 ? (
          <WallEmptyState title="No reviews yet.">
            <p>Open an artwork and add a rating or review to build this page.</p>
          </WallEmptyState>
        ) : (
          <div className="-mx-3 flex flex-col">
            {reviewed.map((artwork) => (
              <Link
                key={artwork.id}
                to="/artworks/$artworkId"
                params={{ artworkId: artwork.id }}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-secondary/60"
              >
                <span className="truncate">{artwork.title}</span>
                <strong className="tabular-nums">{artwork.rating}/5</strong>
                <small className="text-muted-foreground">
                  {artwork.artist || artwork.artworkType}
                </small>
              </Link>
            ))}
          </div>
        )}
      </div>
    </CosmosShell>
  );
}
