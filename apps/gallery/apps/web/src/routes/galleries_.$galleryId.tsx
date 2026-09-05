import { env } from "@aqt/gallery-env/web";
import { Button } from "@aqt/gallery-ui/components/button";
import { Input } from "@aqt/gallery-ui/components/input";
import { Label } from "@aqt/gallery-ui/components/label";
import { Textarea } from "@aqt/gallery-ui/components/textarea";
import { cn } from "@aqt/gallery-ui/lib/utils";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronUp, GripVertical, Star, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { GalleryThemePanel } from "@/components/gallery/gallery-theme-panel";
import { useImportController } from "@/components/gallery/import-provider";
import { type ArchiveArtwork, useGalleryCuration } from "@/components/gallery/use-gallery-curation";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/galleries_/$galleryId")({
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
  const { galleryId } = Route.useParams();
  const [search, setSearch] = useState("");
  return (
    <CosmosShell active="galleries" search={search} onSearch={setSearch}>
      <StudioBody galleryId={galleryId} search={search} />
    </CosmosShell>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
      {children}
    </p>
  );
}

function thumbUrl(a: { thumbnailUrl: string | null }) {
  return a.thumbnailUrl ? `${env.VITE_SERVER_URL}${a.thumbnailUrl}` : null;
}

function StudioBody({ galleryId, search }: { galleryId: string; search: string }) {
  const navigate = useNavigate();
  const { openImport, setImportTarget } = useImportController();
  const curation = useGalleryCuration(galleryId);
  const { group, members, available, selected, busy, addArtworks } = curation;

  // The header search filters the archive picker below.
  const query = search.trim().toLowerCase();
  const visibleAvailable = query
    ? available.filter(
        (a) =>
          a.title.toLowerCase().includes(query) || (a.artist ?? "").toLowerCase().includes(query),
      )
    : available;

  const [details, setDetails] = useState({
    name: "",
    tagline: "",
    description: "",
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on gallery switch
  useEffect(() => {
    if (group) {
      setDetails({
        name: group.name,
        tagline: group.tagline ?? "",
        description: group.description ?? "",
      });
    }
  }, [group?.id]);

  // Register this gallery as the import destination while the studio is open,
  // so the header button and the `i` shortcut both import straight in here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-register on gallery identity only, not on every query refetch that yields a fresh `group` object
  useEffect(() => {
    if (!group) return;
    setImportTarget({ label: group.name, onImported: addArtworks });
    return () => setImportTarget(null);
  }, [group?.id, group?.name, setImportTarget, addArtworks]);

  if (curation.loaded && !group) {
    return (
      <div className="mx-auto w-full max-w-[1120px] pt-20">
        <div className="flex max-w-xl flex-col items-start gap-3">
          <h1 className="text-2xl font-semibold">Gallery not found.</h1>
          <p className="text-sm text-muted-foreground">
            This gallery may have been deleted, or it belongs to another account.
          </p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/galleries">← Back to galleries</Link>}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8 pt-6">
      {/* Heading + actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel>Curated gallery</SectionLabel>
          <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight">
            {group?.name ?? "Gallery"}
          </h1>
          {group?.tagline ? (
            <p className="mt-1 text-sm text-muted-foreground">{group.tagline}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {group ? (
            <Button
              variant="outline"
              render={
                <Link to="/museum/$kind/$slug" params={{ kind: "g", slug: group.slug }}>
                  Walk through →
                </Link>
              }
            />
          ) : null}
          <Button
            variant="outline"
            disabled={busy || !group}
            onClick={() => void curation.togglePublish()}
          >
            {group?.isPublished ? "Unpublish" : "Publish"}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !group}
            onClick={async () => {
              if (!group) return;
              if (!window.confirm(`Delete "${group.name}"? The artworks themselves are kept.`)) {
                return;
              }
              await curation.deleteGroup();
              navigate({ to: "/galleries" });
            }}
          >
            <Trash2 />
            Delete
          </Button>
        </div>
      </div>

      {/* Details */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="detail-name">Name</Label>
          <Input
            id="detail-name"
            value={details.name}
            onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="detail-tagline">Tagline</Label>
          <Input
            id="detail-tagline"
            value={details.tagline}
            onChange={(e) => setDetails((d) => ({ ...d, tagline: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="detail-description">Description</Label>
          <Textarea
            id="detail-description"
            rows={2}
            value={details.description}
            onChange={(e) => setDetails((d) => ({ ...d, description: e.target.value }))}
          />
        </div>
        <div>
          <Button
            disabled={busy || details.name.trim().length === 0}
            onClick={() => void curation.saveDetails(details)}
          >
            Save details
          </Button>
        </div>
      </div>

      {/* Room theme */}
      <div className="flex flex-col gap-1">
        <SectionLabel>Room theme</SectionLabel>
        <p className="text-xs text-muted-foreground">
          How this gallery's 3D room looks when visitors walk through.
        </p>
        {group ? (
          <GalleryThemePanel
            groupId={group.id}
            theme={group.theme}
            disabled={busy}
            onSave={curation.saveTheme}
          />
        ) : null}
      </div>

      {/* Members */}
      <div className="flex flex-col gap-2">
        <SectionLabel>
          In this gallery — {members.length} {members.length === 1 ? "artwork" : "artworks"}
        </SectionLabel>
        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing here yet. Import artworks or add them from your archive below.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Drag or use the arrow buttons to reorder. The star sets the gallery cover.
            </p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {members.map((a, i) => {
                const isCover = group?.coverArtworkId ? group.coverArtworkId === a.id : i === 0;
                const explicitCover = group?.coverArtworkId === a.id;
                const url = thumbUrl(a);
                return (
                  <li
                    key={a.id}
                    className={cn(
                      "flex items-center gap-3 border bg-card p-2 transition-colors",
                      !busy && "cursor-grab",
                      dragId === a.id && "opacity-50",
                      overId === a.id &&
                        dragId &&
                        dragId !== a.id &&
                        "border-ring shadow-[inset_0_2px_0_var(--color-ring)]",
                    )}
                    draggable={!busy}
                    onDragStart={(e) => {
                      setDragId(a.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", a.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (overId !== a.id) setOverId(a.id);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId) curation.move(dragId, a.id);
                      setDragId(null);
                      setOverId(null);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                    }}
                  >
                    <GripVertical
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="w-5 text-center text-xs text-muted-foreground">{i + 1}</span>
                    {url ? (
                      <img
                        src={url}
                        alt=""
                        draggable={false}
                        className="size-12 shrink-0 object-cover ring-1 ring-foreground/10"
                      />
                    ) : (
                      <div className="size-12 shrink-0 bg-muted ring-1 ring-foreground/10" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{a.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.artist ?? "Unknown artist"}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Move up"
                        title="Move up"
                        disabled={busy || i === 0}
                        onClick={() => {
                          const prev = members[i - 1];
                          if (prev) curation.move(a.id, prev.id);
                        }}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Move down"
                        title="Move down"
                        disabled={busy || i === members.length - 1}
                        onClick={() => {
                          const next = members[i + 1];
                          if (next) curation.move(a.id, next.id);
                        }}
                      >
                        <ChevronDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-pressed={explicitCover}
                        aria-label={
                          explicitCover ? "Current cover — click to reset" : "Set as cover"
                        }
                        title={explicitCover ? "Current cover — click to reset" : "Set as cover"}
                        className={cn(isCover && "text-amber-400")}
                        disabled={busy}
                        onClick={() => void curation.setCover(explicitCover ? null : a.id)}
                      >
                        <Star fill={isCover ? "currentColor" : "none"} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove from gallery"
                        title="Remove from gallery"
                        className="hover:text-destructive"
                        disabled={busy}
                        onClick={() => curation.remove(a.id)}
                      >
                        <X />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* Archive picker */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Your archive — tap to select</SectionLabel>
          <div className="flex items-center gap-2">
            {selected.size > 0 ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={curation.clearSelected}>
                  Clear
                </Button>
                <Button size="sm" disabled={busy} onClick={curation.addSelected}>
                  <Check />
                  Add {selected.size} selected
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={openImport}>
                <Upload />
                Import artworks
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Adding an artwork publishes it so it can appear in the museum.
        </p>
        {!curation.archiveLoaded ? null : available.length === 0 ? (
          <div className="flex flex-col items-start gap-3 border border-dashed border-border bg-card/40 px-5 py-8 text-xs text-muted-foreground">
            <span>
              {members.length === 0
                ? "Your archive is empty — import artworks to get started."
                : "Every artwork in your archive is already in this gallery."}
            </span>
            <Button variant="outline" size="sm" onClick={openImport}>
              <Upload />
              Import artworks
            </Button>
          </div>
        ) : visibleAvailable.length === 0 ? (
          <p className="text-xs text-muted-foreground">No archive artworks match “{search}”.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-3">
            {visibleAvailable.map((a) => (
              <ArchiveTile
                key={a.id}
                artwork={a}
                selected={selected.has(a.id)}
                onToggle={() => curation.toggleSelected(a.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ArchiveTile({
  artwork,
  selected,
  onToggle,
}: {
  artwork: ArchiveArtwork;
  selected: boolean;
  onToggle: () => void;
}) {
  const url = thumbUrl(artwork);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      title={`Select "${artwork.title}"`}
      className={cn(
        "group relative aspect-square overflow-hidden bg-card ring-1 ring-foreground/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-ring",
      )}
    >
      {url ? (
        <img
          src={url}
          alt={artwork.title}
          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
      ) : (
        <span className="grid size-full place-items-center p-2 text-center text-xs text-muted-foreground">
          {artwork.title}
        </span>
      )}
      <span
        className={cn(
          "absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full transition-opacity",
          selected
            ? "bg-primary text-primary-foreground opacity-100"
            : "bg-black/55 text-white opacity-0 group-hover:opacity-100",
        )}
      >
        <Check className="size-3.5" />
      </span>
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pt-5 pb-1.5 text-left text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {artwork.title}
      </span>
    </button>
  );
}
