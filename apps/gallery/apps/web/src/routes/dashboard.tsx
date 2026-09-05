import { Button } from "@aqt/gallery-ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CheckSquare } from "lucide-react";
import { useState } from "react";

import { ArchiveControls, type ArchiveSort } from "@/components/gallery/archive-controls";
import { BulkActionBar } from "@/components/gallery/bulk-action-bar";
import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { MasonryWall } from "@/components/gallery/masonry-wall";
import type { ArtworkType } from "@/components/gallery/types";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard")({
  component: RouteComponent,
  beforeLoad: async () => {
    const session = await getUser();
    return { session };
  },
  loader: async ({ context }) => {
    if (!context.session) {
      throw redirect({
        to: "/login",
      });
    }
  },
});

function RouteComponent() {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ArchiveSort>("newest");
  const [artworkType, setArtworkType] = useState<ArtworkType | "all">("all");
  const [tagId, setTagId] = useState<string | "all">("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const artworks = useQuery(
    trpc.artworks.list.queryOptions({
      query: search,
      sort,
      artworkType: artworkType === "all" ? undefined : artworkType,
      tagId: tagId === "all" ? undefined : tagId,
    }),
  );
  const cards = artworks.data ?? [];

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) setSelected(new Set());
      return !prev;
    });
  };

  // Only act on selections still present in the current (filtered) view.
  const selectedInView = cards.map((card) => card.id).filter((id) => selected.has(id));

  return (
    <CosmosShell active="archive" search={search} onSearch={setSearch}>
      <ArchiveControls
        sort={sort}
        onSort={setSort}
        artworkType={artworkType}
        onArtworkType={setArtworkType}
        tagId={tagId}
        onTagId={setTagId}
        count={cards.length}
        action={
          <Button
            variant={selectMode ? "secondary" : "outline"}
            size="sm"
            onClick={toggleSelectMode}
          >
            <CheckSquare />
            {selectMode ? "Done" : "Select"}
          </Button>
        }
      />
      <MasonryWall
        artworks={cards}
        selectable={selectMode}
        selectedIds={selected}
        onToggleSelect={toggleSelect}
      />
      {selectMode && selectedInView.length > 0 ? (
        <BulkActionBar
          selected={selectedInView}
          cards={cards}
          onClear={() => setSelected(new Set())}
        />
      ) : null}
    </CosmosShell>
  );
}
