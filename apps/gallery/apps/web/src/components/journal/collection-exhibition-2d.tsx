import { Button } from "@aqt/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aqt/ui/components/dialog";
import { cn } from "@aqt/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Expand, Footprints, Grid2X2, List, X } from "lucide-react";
import { useEffect, useMemo } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import type { ExhibitionPayload } from "@/components/museum/types";

export type ExhibitionLayout = "masonry" | "list";

type CollectionArtwork = ExhibitionPayload["rooms"][number]["artworks"][number];

type CollectionExhibition2DProps = {
  collection: ExhibitionPayload;
  layout: ExhibitionLayout;
  selectedArtworkId?: string;
  onSelectArtwork: (artworkId: string) => void;
  onCloseArtwork: () => void;
};

function artworkRatio(artwork: CollectionArtwork) {
  return artwork.imageWidth && artwork.imageHeight
    ? `${artwork.imageWidth} / ${artwork.imageHeight}`
    : "4 / 5";
}

function artworkByline(artwork: CollectionArtwork) {
  return [artwork.artistName, artwork.year, artwork.medium].filter(Boolean).join(" · ");
}

function ArtworkImage({
  artwork,
  index,
  full = false,
}: {
  artwork: CollectionArtwork;
  index: number;
  full?: boolean;
}) {
  const src = full
    ? (artwork.imageUrl ?? artwork.thumbnailUrl)
    : (artwork.thumbnailUrl ?? artwork.imageUrl);
  const hasNativeSize = Boolean(artwork.imageWidth && artwork.imageHeight);
  const width = hasNativeSize ? (artwork.imageWidth ?? 800) : 800;
  const height = hasNativeSize ? (artwork.imageHeight ?? 1_000) : 1_000;

  return (
    <div
      className={cn(
        "grid w-full place-items-center overflow-hidden rounded-lg bg-secondary",
        full && "h-full min-h-0",
      )}
      style={full ? undefined : { aspectRatio: artworkRatio(artwork) }}
    >
      {src ? (
        <img
          src={src}
          alt={artwork.title}
          width={width}
          height={height}
          loading={full || index < 2 ? "eager" : "lazy"}
          fetchPriority={full || index < 2 ? "high" : "auto"}
          decoding="async"
          className={cn("size-full object-contain", full && "max-h-full max-w-full")}
        />
      ) : (
        <span className="px-4 text-center text-sm text-muted-foreground">Image unavailable</span>
      )}
    </div>
  );
}

function MasonryArtwork({
  artwork,
  index,
  total,
  onSelect,
}: {
  artwork: CollectionArtwork;
  index: number;
  total: number;
  onSelect: () => void;
}) {
  return (
    <article className="mb-10 break-inside-avoid [contain-intrinsic-size:auto_32rem] [content-visibility:auto]">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Inspect ${artwork.title}, work ${index + 1} of ${total}`}
        className="group block w-full text-left outline-none"
      >
        <div className="relative overflow-hidden rounded-lg transition-opacity duration-200 group-focus-visible:opacity-90 motion-reduce:transition-none">
          <ArtworkImage artwork={artwork} index={index} />
          <span className="absolute right-3 bottom-3 grid size-8 translate-y-1 place-items-center rounded-full bg-background/90 text-foreground opacity-0 backdrop-blur transition-[opacity,transform] duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:transition-none">
            <Expand className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <div className="mt-3 grid grid-cols-[2rem_1fr] gap-2">
          <span className="pt-0.5 text-xs font-medium text-muted-foreground tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div>
            <h2 className="text-base leading-tight font-medium text-balance break-words">
              {artwork.title}
            </h2>
            {artworkByline(artwork) ? (
              <p className="mt-1 text-sm text-muted-foreground">{artworkByline(artwork)}</p>
            ) : null}
          </div>
        </div>
      </button>
      {artwork.placement.note ? (
        <p className="mt-3 ml-10 text-sm leading-6 break-words text-muted-foreground">
          {artwork.placement.note}
        </p>
      ) : null}
    </article>
  );
}

function ListArtwork({
  artwork,
  index,
  total,
  onSelect,
}: {
  artwork: CollectionArtwork;
  index: number;
  total: number;
  onSelect: () => void;
}) {
  return (
    <article className="grid gap-5 py-8 [contain-intrinsic-size:auto_40rem] [content-visibility:auto] md:grid-cols-[minmax(0,1.35fr)_minmax(16rem,0.65fr)] md:gap-10 md:py-12">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Inspect ${artwork.title}, work ${index + 1} of ${total}`}
        className="group relative block w-full overflow-hidden rounded-lg transition-opacity duration-200 outline-none focus-visible:opacity-90 motion-reduce:transition-none"
      >
        <ArtworkImage artwork={artwork} index={index} />
        <span className="absolute right-3 bottom-3 grid size-8 translate-y-1 place-items-center rounded-full bg-background/90 text-foreground opacity-0 backdrop-blur transition-[opacity,transform] duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:transition-none">
          <Expand className="size-3.5" aria-hidden="true" />
        </span>
      </button>
      <div className="flex flex-col justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground tabular-nums">
            Work {String(index + 1).padStart(2, "0")} of {String(total).padStart(2, "0")}
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-balance break-words">
            {artwork.title}
          </h2>
          {artworkByline(artwork) ? (
            <p className="mt-2 text-sm text-muted-foreground">{artworkByline(artwork)}</p>
          ) : null}
        </div>
        {artwork.placement.note ? (
          <p className="mt-8 max-w-prose text-sm leading-6 break-words text-muted-foreground">
            {artwork.placement.note}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function ArtworkInspector({
  artworks,
  selectedArtworkId,
  onSelectArtwork,
  onCloseArtwork,
}: {
  artworks: CollectionArtwork[];
  selectedArtworkId?: string;
  onSelectArtwork: (artworkId: string) => void;
  onCloseArtwork: () => void;
}) {
  const selectedIndex = useMemo(
    () => artworks.findIndex((artwork) => artwork.id === selectedArtworkId),
    [artworks, selectedArtworkId],
  );
  const selected = selectedIndex >= 0 ? artworks[selectedIndex] : undefined;
  const previous = selectedIndex > 0 ? artworks[selectedIndex - 1] : artworks.at(-1);
  const next =
    selectedIndex >= 0 && selectedIndex < artworks.length - 1
      ? artworks[selectedIndex + 1]
      : artworks[0];

  useEffect(() => {
    if (!selected) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && previous) {
        event.preventDefault();
        onSelectArtwork(previous.id);
      }
      if (event.key === "ArrowRight" && next) {
        event.preventDefault();
        onSelectArtwork(next.id);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [next, onSelectArtwork, previous, selected]);

  return (
    <Dialog
      open={Boolean(selected)}
      onOpenChange={(open) => {
        if (!open) onCloseArtwork();
      }}
    >
      {selected ? (
        <DialogContent
          showCloseButton={false}
          className="h-[min(92svh,58rem)] max-h-none gap-0 overflow-hidden overscroll-contain p-0 sm:w-[calc(100%-3rem)] sm:max-w-[min(94vw,84rem)]"
        >
          <DialogClose className="absolute top-3 right-3 z-10 grid size-9 place-items-center rounded-full bg-background/90 text-foreground backdrop-blur transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close artwork inspector</span>
          </DialogClose>
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(12rem,1fr)_minmax(0,0.9fr)] md:grid-cols-[minmax(0,1.45fr)_minmax(19rem,0.55fr)] md:grid-rows-1">
            <div className="min-h-0 p-3 sm:p-6 md:p-8">
              <ArtworkImage artwork={selected} index={selectedIndex} full />
            </div>
            <div className="flex min-h-0 flex-col bg-card">
              <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
                <DialogHeader className="pr-8">
                  <p className="text-xs font-medium text-muted-foreground tabular-nums">
                    Work {String(selectedIndex + 1).padStart(2, "0")} of{" "}
                    {String(artworks.length).padStart(2, "0")}
                  </p>
                  <DialogTitle className="mt-4 text-2xl leading-tight font-semibold tracking-[-0.02em] text-balance break-words sm:text-3xl">
                    {selected.title}
                  </DialogTitle>
                  <DialogDescription className="mt-2 text-sm leading-6">
                    {artworkByline(selected) || "Artwork details unavailable"}
                  </DialogDescription>
                </DialogHeader>
                {selected.dimensions ? (
                  <p className="mt-5 text-sm text-muted-foreground">{selected.dimensions}</p>
                ) : null}
                {selected.placement.note ? (
                  <div className="mt-8">
                    <p className="text-xs font-medium text-muted-foreground">Curatorial note</p>
                    <p className="mt-3 text-sm leading-7 break-words text-muted-foreground">
                      {selected.placement.note}
                    </p>
                  </div>
                ) : null}
              </div>
              <div className="px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
                <progress
                  value={selectedIndex + 1}
                  max={artworks.length}
                  aria-label={`Collection progress, work ${selectedIndex + 1} of ${artworks.length}`}
                  className="h-1 w-full accent-foreground"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => previous && onSelectArtwork(previous.id)}
                    disabled={artworks.length < 2}
                  >
                    <ArrowLeft aria-hidden="true" />
                    Previous
                  </Button>
                  <span className="hidden text-xs text-muted-foreground lg:inline">
                    Use arrow keys to move
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => next && onSelectArtwork(next.id)}
                    disabled={artworks.length < 2}
                  >
                    Next
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function CollectionExhibition2D({
  collection,
  layout,
  selectedArtworkId,
  onSelectArtwork,
  onCloseArtwork,
}: CollectionExhibition2DProps) {
  const artworks = collection.rooms[0]?.artworks ?? [];

  return (
    <CosmosShell active="journal">
      <main className="mx-auto max-w-[1320px] pt-8">
        <header className="flex flex-wrap items-end justify-between gap-6 pb-8">
          <div className="max-w-2xl">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3.5"
              nativeButton={false}
              render={<Link to="/journal" />}
            >
              Journal
            </Button>
            <p className="mt-5 text-xs font-medium text-muted-foreground">Private collection</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-[-0.03em] text-balance break-words sm:text-5xl">
              {collection.name}
            </h1>
            {collection.description ? (
              <p className="mt-3 max-w-xl text-sm leading-6 break-words text-muted-foreground">
                {collection.description}
              </p>
            ) : null}
          </div>
          <Button
            nativeButton={false}
            render={
              <Link
                to="/collection/$collectionId"
                params={{ collectionId: collection.id }}
                search={{ view: "3d", layout }}
              />
            }
          >
            <Footprints />
            Walk in 3D
          </Button>
        </header>

        <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 bg-background/90 px-1 py-4 backdrop-blur">
          <p className="text-xs font-medium text-muted-foreground tabular-nums">
            {artworks.length} {artworks.length === 1 ? "work" : "works"}
          </p>
          <nav
            className="inline-flex items-center gap-0.5 rounded-full bg-card p-1"
            aria-label="Exhibition layout"
          >
            <Link
              to="/collection/$collectionId"
              params={{ collectionId: collection.id }}
              search={{ view: "2d", layout: "masonry" }}
              aria-current={layout === "masonry" ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                layout === "masonry"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Grid2X2 className="size-3.5" aria-hidden="true" />
              Masonry
            </Link>
            <Link
              to="/collection/$collectionId"
              params={{ collectionId: collection.id }}
              search={{ view: "2d", layout: "list" }}
              aria-current={layout === "list" ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                layout === "list"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <List className="size-3.5" aria-hidden="true" />
              List
            </Link>
          </nav>
        </div>

        {artworks.length > 0 ? (
          layout === "masonry" ? (
            <div className="mt-8 columns-1 gap-6 sm:columns-2 xl:columns-3">
              {artworks.map((artwork, index) => (
                <MasonryArtwork
                  key={artwork.id}
                  artwork={artwork}
                  index={index}
                  total={artworks.length}
                  onSelect={() => onSelectArtwork(artwork.id)}
                />
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {artworks.map((artwork, index) => (
                <ListArtwork
                  key={artwork.id}
                  artwork={artwork}
                  index={index}
                  total={artworks.length}
                  onSelect={() => onSelectArtwork(artwork.id)}
                />
              ))}
            </div>
          )
        ) : (
          <div className="mt-8 rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Add works in Journal to begin this exhibition.
          </div>
        )}
      </main>

      <ArtworkInspector
        artworks={artworks}
        selectedArtworkId={selectedArtworkId}
        onSelectArtwork={onSelectArtwork}
        onCloseArtwork={onCloseArtwork}
      />
    </CosmosShell>
  );
}
