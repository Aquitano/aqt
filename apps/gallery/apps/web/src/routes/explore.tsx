import { Button } from "@aqt/gallery-ui/components/button";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CheckSquare, Plus } from "lucide-react";
import { useCallback, useState } from "react";

import {
  ArchiveControls,
  type ArchiveFilterId,
  type ArchiveSort,
} from "@/components/gallery/archive-controls";
import { ArtworkTile } from "@/components/gallery/artwork-tile";
import { BulkActionBar } from "@/components/gallery/bulk-action-bar";
import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { ExhibitionEditorDialog } from "@/components/gallery/exhibition-editor-dialog";
import { ExploreSwitch } from "@/components/gallery/explore-switch";
import { useImportController } from "@/components/gallery/import-provider";
import { MasonryWall, WallEmptyState } from "@/components/gallery/masonry-wall";
import { SpaceTile, type SpaceTileData } from "@/components/gallery/space-tile";
import {
  type ArtworkCard,
  type ArtworkType,
  type ExploreView,
  isExploreView,
} from "@/components/gallery/types";
import { type CuratedExhibition, isCurated } from "@/components/gallery/use-exhibition-curation";
import { getUser } from "@/functions/get-user";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useTRPC } from "@/utils/trpc";

type ExploreSearch = { view?: ExploreView };

export const Route = createFileRoute("/explore")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): ExploreSearch =>
    isExploreView(search.view) && search.view !== "artworks" ? { view: search.view } : {},
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

const SEARCH_HINT: Record<ExploreView, string> = {
  artworks: "Try 'Botticelli' or 'still life'",
  spaces: "Search galleries and museums",
};

function RouteComponent() {
  const view = Route.useSearch().view ?? "artworks";
  const [search, setSearch] = useState("");

  return (
    <CosmosShell
      active="explore"
      search={search}
      onSearch={setSearch}
      searchPlaceholder={SEARCH_HINT[view]}
    >
      {view === "artworks" ? <ArtworksWall search={search} /> : <SpacesWall search={search} />}
    </CosmosShell>
  );
}

function ArtworksWall({ search }: { search: string }) {
  const trpc = useTRPC();
  const { openImport } = useImportController();
  // Debounce the value that feeds the query key so typing doesn't fire a
  // request per keystroke; keepPreviousData avoids a loading flash between them.
  const debouncedSearch = useDebouncedValue(search);
  const [sort, setSort] = useState<ArchiveSort>("newest");
  const [artworkType, setArtworkType] = useState<ArtworkType | "all">("all");
  const [tagId, setTagId] = useState<ArchiveFilterId>("all");
  const [artistId, setArtistId] = useState<ArchiveFilterId>("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const artworks = useQuery({
    ...trpc.artworks.list.queryOptions({
      query: debouncedSearch,
      sort,
      artworkType: artworkType === "all" ? undefined : artworkType,
      tagId: tagId === "all" ? undefined : tagId,
      artistId: artistId === "all" ? undefined : artistId,
    }),
    placeholderData: keepPreviousData,
  });
  const cards = (artworks.data ?? []) as ArtworkCard[];

  // Stable identity (functional updater) so memoized ArtworkTiles don't all
  // re-render when one selection toggles.
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) setSelected(new Set());
      return !prev;
    });
  };

  // Only act on selections still present in the current (filtered) view.
  const selectedInView = cards.map((card) => card.id).filter((id) => selected.has(id));

  return (
    <>
      <ArchiveControls
        lead={<ExploreSwitch active="artworks" />}
        sort={sort}
        onSort={setSort}
        artworkType={artworkType}
        onArtworkType={setArtworkType}
        tagId={tagId}
        onTagId={setTagId}
        artistId={artistId}
        onArtistId={setArtistId}
        count={cards.length}
        action={
          <Button variant={selectMode ? "secondary" : "ghost"} size="sm" onClick={toggleSelectMode}>
            <CheckSquare />
            {selectMode ? "Done" : "Select"}
          </Button>
        }
      />
      {artworks.isSuccess && cards.length === 0 ? (
        <WallEmptyState title={search ? "Nothing matches." : "Your archive is waiting."}>
          <p>
            {search
              ? "Try another title, artist or tag."
              : "Import images to start the wall, then shape each work into a journal entry."}
          </p>
          {search ? null : (
            <Button className="mt-5" onClick={openImport}>
              <Plus />
              Import artworks
            </Button>
          )}
        </WallEmptyState>
      ) : (
        <MasonryWall>
          {cards.map((artwork, index) => (
            <ArtworkTile
              key={artwork.id}
              artwork={artwork}
              index={index}
              selectable={selectMode}
              selected={selected.has(artwork.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </MasonryWall>
      )}
      {selectMode && selectedInView.length > 0 ? (
        <BulkActionBar
          selected={selectedInView}
          cards={cards}
          onClear={() => setSelected(new Set())}
        />
      ) : null}
    </>
  );
}

function toSpace(e: CuratedExhibition): SpaceTileData {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    tagline: e.tagline,
    coverImageUrl: e.coverImageUrl,
    isPublished: e.isPublished,
    roomCount: e.rooms.length,
    artworkCount: e.rooms.reduce((total, room) => total + room.placements.length, 0),
  };
}

/** Your own galleries and museums (drafts included) first, then everything
 * other curators have published. */
function SpacesWall({ search }: { search: string }) {
  const trpc = useTRPC();
  const mine = useQuery(trpc.exhibitions.mine.queryOptions());
  const lobby = useQuery(trpc.exhibitions.lobby.queryOptions());
  const [editorOpen, setEditorOpen] = useState(false);
  const needle = search.trim().toLowerCase();
  const own = (mine.data ?? []).filter(isCurated).map(toSpace);
  const ownIds = new Set(own.map((e) => e.id));
  const published = (lobby.data?.exhibitions ?? [])
    .filter((e) => !ownIds.has(e.id))
    .map((e) => ({ ...e, isPublished: true }));
  const spaces = [...own, ...published].filter(
    (e) => !needle || e.name.toLowerCase().includes(needle),
  );
  const loaded = mine.isSuccess && lobby.isSuccess;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 py-4">
        <ExploreSwitch active="spaces" />
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {spaces.length} {spaces.length === 1 ? "space" : "spaces"}
          </span>
          <Button size="sm" onClick={() => setEditorOpen(true)}>
            <Plus />
            New gallery
          </Button>
        </div>
      </div>
      {loaded && spaces.length === 0 ? (
        <WallEmptyState title={needle ? "Nothing matches." : "No spaces yet."}>
          <p>
            {needle
              ? "Try another gallery or museum name."
              : "A gallery is one room of works from your archive. Add more rooms in the studio and it becomes a museum."}
          </p>
          {needle ? null : (
            <Button className="mt-5" onClick={() => setEditorOpen(true)}>
              <Plus />
              New gallery
            </Button>
          )}
        </WallEmptyState>
      ) : (
        <MasonryWall>
          {spaces.map((exhibition, index) => (
            <SpaceTile key={exhibition.id} exhibition={exhibition} index={index} />
          ))}
        </MasonryWall>
      )}
      <ExhibitionEditorDialog open={editorOpen} onOpenChange={setEditorOpen} />
    </>
  );
}
