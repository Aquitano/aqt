import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { ArchiveControls, type ArchiveSort } from "@/components/gallery/archive-controls";
import { CosmosShell } from "@/components/gallery/cosmos-shell";
import type { ArtworkType } from "@/components/gallery/types";
import { getUser } from "@/functions/get-user";
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
  const [sort, setSort] = useState<ArchiveSort>("rating");
  const [artworkType, setArtworkType] = useState<ArtworkType | "all">("all");
  const [tagId, setTagId] = useState<string | "all">("all");
  const artworks = useQuery(
    trpc.artworks.list.queryOptions({
      query: search,
      sort,
      artworkType: artworkType === "all" ? undefined : artworkType,
      tagId: tagId === "all" ? undefined : tagId,
    }),
  );
  const reviewed = (artworks.data ?? []).filter((artwork) => artwork.rating);

  return (
    <CosmosShell active="reviews" search={search} onSearch={setSearch}>
      <div className="mx-auto w-full max-w-[1120px] pt-6">
        <div className="mb-6">
          <p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
            Seen and scored
          </p>
          <h1 className="mt-1 font-semibold text-3xl tracking-tight">Reviews</h1>
        </div>
        <ArchiveControls
          sort={sort}
          onSort={setSort}
          artworkType={artworkType}
          onArtworkType={setArtworkType}
          tagId={tagId}
          onTagId={setTagId}
          count={reviewed.length}
        />
        {reviewed.length === 0 ? (
          <div className="flex max-w-xl flex-col items-start gap-2 pt-10">
            <h2 className="font-semibold text-xl">No reviews yet.</h2>
            <p className="text-muted-foreground text-sm">
              Open an artwork and add a rating or review to build this page.
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {reviewed.map((artwork) => (
              <Link
                key={artwork.id}
                to="/artworks/$artworkId"
                params={{ artworkId: artwork.id }}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-border/60 border-t py-3.5 text-sm transition-colors hover:bg-card/60"
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
