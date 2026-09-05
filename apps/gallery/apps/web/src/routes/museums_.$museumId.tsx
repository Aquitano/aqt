import { env } from "@aqt-gallery/env/web";
import { Button } from "@aqt-gallery/ui/components/button";
import { Input } from "@aqt-gallery/ui/components/input";
import { Label } from "@aqt-gallery/ui/components/label";
import { Textarea } from "@aqt-gallery/ui/components/textarea";
import { cn } from "@aqt-gallery/ui/lib/utils";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Plus,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { GalleryThemePanel } from "@/components/gallery/gallery-theme-panel";
import { useImportController } from "@/components/gallery/import-provider";
import type { ArchiveArtwork } from "@/components/gallery/use-gallery-curation";
import {
  type MuseumCuration,
  type RoomView,
  useMuseumCuration,
} from "@/components/gallery/use-museum-curation";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/museums_/$museumId")({
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
  const { museumId } = Route.useParams();
  const [search, setSearch] = useState("");
  return (
    <CosmosShell active="museums" search={search} onSearch={setSearch}>
      <StudioBody museumId={museumId} search={search} />
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

function StudioBody({ museumId, search }: { museumId: string; search: string }) {
  const navigate = useNavigate();
  const { openImport } = useImportController();
  const curation = useMuseumCuration(museumId);
  const { museum, rooms, available, busy } = curation;

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
  const [newRoomName, setNewRoomName] = useState("");
  // Which room the archive picker adds to.
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on museum switch
  useEffect(() => {
    if (museum) {
      setDetails({
        name: museum.name,
        tagline: museum.tagline ?? "",
        description: museum.description ?? "",
      });
    }
  }, [museum?.id]);

  // Keep a valid add-target: default to the first room, and recover if the
  // active room is deleted.
  useEffect(() => {
    const roomIds = rooms.map((r) => r.id);
    if (activeRoomId && roomIds.includes(activeRoomId)) return;
    setActiveRoomId(roomIds[0] ?? null);
  }, [rooms, activeRoomId]);

  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;

  // When no cover is chosen, the server falls back to the museum's first hung
  // artwork (first room with members), so highlight that one as the implicit
  // cover — matching the gallery studio and the card/lobby display.
  const implicitCoverId = rooms.find((r) => r.members.length > 0)?.members[0]?.id ?? null;

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const addSelected = () => {
    if (!activeRoomId) return;
    const toAdd = available.filter((a) => selected.has(a.id)).map((a) => a.id);
    if (toAdd.length === 0) return;
    setSelected(new Set());
    curation.addToRoom(activeRoomId, toAdd);
  };

  const focusPicker = (roomId: string) => {
    setActiveRoomId(roomId);
    pickerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (curation.loaded && !museum) {
    return (
      <div className="mx-auto w-full max-w-[1120px] pt-20">
        <div className="flex max-w-xl flex-col items-start gap-3">
          <h1 className="text-2xl font-semibold">Museum not found.</h1>
          <p className="text-sm text-muted-foreground">
            This museum may have been deleted, or it belongs to another account.
          </p>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/museums">← Back to museums</Link>}
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
          <SectionLabel>Multi-room museum</SectionLabel>
          <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight">
            {museum?.name ?? "Museum"}
          </h1>
          {museum?.tagline ? (
            <p className="mt-1 text-sm text-muted-foreground">{museum.tagline}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {museum ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link to="/museum/$kind/$slug" params={{ kind: "m", slug: museum.slug }}>
                  Walk through →
                </Link>
              }
            />
          ) : null}
          <Button
            variant="outline"
            disabled={busy || !museum}
            onClick={() => void curation.togglePublish()}
          >
            {museum?.isPublished ? "Unpublish" : "Publish"}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !museum}
            onClick={async () => {
              if (!museum) return;
              if (
                !window.confirm(
                  `Delete "${museum.name}" and all its rooms? The artworks themselves are kept.`,
                )
              ) {
                return;
              }
              await curation.deleteMuseum();
              navigate({ to: "/museums" });
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

      {/* Theme */}
      <div className="flex flex-col gap-1">
        <SectionLabel>Museum theme</SectionLabel>
        <p className="text-xs text-muted-foreground">
          How this museum's 3D rooms look when visitors walk through.
        </p>
        {museum ? (
          <GalleryThemePanel
            groupId={museum.id}
            theme={museum.theme}
            disabled={busy}
            onSave={curation.saveTheme}
          />
        ) : null}
      </div>

      {/* Rooms */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>
            Rooms — {rooms.length} {rooms.length === 1 ? "room" : "rooms"}
          </SectionLabel>
          <div className="flex items-center gap-2">
            <Input
              value={newRoomName}
              placeholder="New room name"
              className="h-8 w-44"
              disabled={busy || !museum}
              onChange={(e) => setNewRoomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newRoomName.trim()) {
                  void curation.addRoom(newRoomName).then((created) => {
                    setNewRoomName("");
                    if (created) setActiveRoomId(created.id);
                  });
                }
              }}
            />
            <Button
              size="sm"
              disabled={busy || !museum || newRoomName.trim().length === 0}
              onClick={() =>
                void curation.addRoom(newRoomName).then((created) => {
                  setNewRoomName("");
                  if (created) setActiveRoomId(created.id);
                })
              }
            >
              <Plus />
              Add room
            </Button>
          </div>
        </div>

        {rooms.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No rooms yet. Add a room above, then hang artworks in it.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {rooms.map((room, index) => (
              <RoomCard
                key={room.id}
                room={room}
                index={index}
                total={rooms.length}
                curation={curation}
                busy={busy}
                coverArtworkId={museum?.coverArtworkId ?? null}
                implicitCoverId={implicitCoverId}
                isActiveTarget={activeRoomId === room.id}
                onAdd={() => focusPicker(room.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Archive picker */}
      <div ref={pickerRef} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>
            {activeRoom ? `Add to "${activeRoom.name}" — tap to select` : "Your archive"}
          </SectionLabel>
          <div className="flex items-center gap-2">
            {selected.size > 0 && activeRoom ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
                <Button size="sm" disabled={busy} onClick={addSelected}>
                  <Check />
                  Add {selected.size} to "{activeRoom.name}"
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
          {rooms.length === 0
            ? "Add a room first, then pick artworks to hang in it."
            : "Adding an artwork publishes it so it can appear in the museum. Each artwork hangs in one room."}
        </p>
        {!curation.archiveLoaded ? null : available.length === 0 ? (
          <div className="flex flex-col items-start gap-3 border border-dashed border-border bg-card/40 px-5 py-8 text-xs text-muted-foreground">
            <span>
              {rooms.some((r) => r.members.length > 0)
                ? "Every artwork in your archive is already hung in this museum."
                : "Your archive is empty — import artworks to get started."}
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
                disabled={!activeRoom}
                onToggle={() => toggleSelected(a.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RoomCard({
  room,
  index,
  total,
  curation,
  busy,
  coverArtworkId,
  implicitCoverId,
  isActiveTarget,
  onAdd,
}: {
  room: RoomView;
  index: number;
  total: number;
  curation: MuseumCuration;
  busy: boolean;
  coverArtworkId: string | null;
  implicitCoverId: string | null;
  isActiveTarget: boolean;
  onAdd: () => void;
}) {
  const [draft, setDraft] = useState({
    name: room.name,
    description: room.description ?? "",
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload form only when the room identity changes, not on every member refetch
  useEffect(() => {
    setDraft({ name: room.name, description: room.description ?? "" });
  }, [room.id]);

  const dirty =
    draft.name.trim() !== room.name || draft.description.trim() !== (room.description ?? "");

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border bg-card p-3 transition-colors",
        isActiveTarget && "border-ring",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center bg-muted text-xs text-muted-foreground">
          {index + 1}
        </span>
        <Input
          value={draft.name}
          aria-label="Room name"
          className="h-8 min-w-0 flex-1"
          disabled={busy}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move room up"
            title="Move room up"
            disabled={busy || index === 0}
            onClick={() => curation.moveRoom(room.id, "up")}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move room down"
            title="Move room down"
            disabled={busy || index === total - 1}
            onClick={() => curation.moveRoom(room.id, "down")}
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete room"
            title="Delete room"
            className="hover:text-destructive"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(`Delete the room "${room.name}"? The artworks themselves are kept.`)
              ) {
                void curation.deleteRoom(room.id);
              }
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={`room-desc-${room.id}`} className="text-[11px] text-muted-foreground">
            Room description
          </Label>
          <Input
            id={`room-desc-${room.id}`}
            value={draft.description}
            placeholder="Shown on the wall as visitors enter"
            className="h-8"
            disabled={busy}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !dirty || draft.name.trim().length === 0}
          onClick={() =>
            void curation.renameRoom(room.id, {
              name: draft.name,
              description: draft.description,
            })
          }
        >
          Save room
        </Button>
      </div>

      {room.members.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Empty room — add artworks from your archive below.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {room.members.map((a, i) => {
            const explicitCover = coverArtworkId === a.id;
            const isCover = coverArtworkId ? explicitCover : a.id === implicitCoverId;
            const url = thumbUrl(a);
            return (
              <li
                key={a.id}
                className={cn(
                  "flex items-center gap-3 border bg-background p-2 transition-colors",
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
                  if (dragId) curation.moveInRoom(room.id, dragId, a.id);
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
                      const prev = room.members[i - 1];
                      if (prev) curation.moveInRoom(room.id, a.id, prev.id);
                    }}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Move down"
                    title="Move down"
                    disabled={busy || i === room.members.length - 1}
                    onClick={() => {
                      const next = room.members[i + 1];
                      if (next) curation.moveInRoom(room.id, a.id, next.id);
                    }}
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-pressed={explicitCover}
                    aria-label={explicitCover ? "Current cover — click to reset" : "Set as cover"}
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
                    aria-label="Remove from room"
                    title="Remove from room"
                    className="hover:text-destructive"
                    disabled={busy}
                    onClick={() => curation.removeFromRoom(room.id, a.id)}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <Button
          variant={isActiveTarget ? "secondary" : "outline"}
          size="sm"
          disabled={busy}
          onClick={onAdd}
        >
          <Plus />
          Add artworks to this room
        </Button>
      </div>
    </div>
  );
}

function ArchiveTile({
  artwork,
  selected,
  disabled,
  onToggle,
}: {
  artwork: ArchiveArtwork;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const url = thumbUrl(artwork);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      title={disabled ? "Pick a room first" : `Select "${artwork.title}"`}
      className={cn(
        "group relative aspect-square overflow-hidden bg-card ring-1 ring-foreground/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
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
