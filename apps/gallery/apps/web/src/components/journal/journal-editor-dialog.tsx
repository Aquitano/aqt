import { Button } from "@aqt/gallery-ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aqt/gallery-ui/components/dialog";
import { Input } from "@aqt/gallery-ui/components/input";
import { Label } from "@aqt/gallery-ui/components/label";
import { Textarea } from "@aqt/gallery-ui/components/textarea";
import { cn } from "@aqt/gallery-ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  ImageIcon,
  LockKeyhole,
  Search,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

export type JournalArtwork = {
  id: string;
  title: string;
  artist: string | null;
  artworkType: string;
  thumbnailUrl: string | null;
  originalUrl: string | null;
  width: number | null;
  height: number | null;
};

export type JournalEditor =
  | {
      kind: "visit";
      id: string;
      name: string;
      artworkIds: string[];
    }
  | {
      kind: "collection";
      id: string;
      name: string;
      description: string | null;
      artworkIds: string[];
      artworkNotes: Record<string, string>;
      coverArtworkId: string | null;
    };

type DraftSnapshot = {
  kind: JournalEditor["kind"];
  name: string;
  description: string;
  artworkIds: string[];
  notes: Record<string, string>;
  coverArtworkId: string | null;
};

function serializeDraft(snapshot: DraftSnapshot) {
  return JSON.stringify(snapshot);
}

function initialSnapshot(editor: JournalEditor): DraftSnapshot {
  return {
    kind: editor.kind,
    name: editor.name.trim(),
    description: editor.kind === "collection" ? (editor.description ?? "").trim() : "",
    artworkIds: editor.kind === "collection" ? editor.artworkIds : [...editor.artworkIds].sort(),
    notes:
      editor.kind === "collection"
        ? Object.fromEntries(
            editor.artworkIds.map((id) => [id, editor.artworkNotes[id]?.trim() ?? ""]),
          )
        : {},
    coverArtworkId: editor.kind === "collection" ? editor.coverArtworkId : null,
  };
}

export function JournalEditorDialog({
  editor,
  archive,
  onClose,
  onSaved,
}: {
  editor: JournalEditor;
  archive: JournalArtwork[];
  onClose: () => void;
  onSaved: (kind: JournalEditor["kind"]) => Promise<void>;
}) {
  const trpc = useTRPC();
  const setVisitArtworks = useMutation(trpc.journal.visits.setArtworks.mutationOptions());
  const saveCollection = useMutation(trpc.journal.collections.save.mutationOptions());
  const [selectedIds, setSelectedIds] = useState(() => new Set(editor.artworkIds));
  const [selectedOrder, setSelectedOrder] = useState(() => editor.artworkIds);
  const [collectionNotes, setCollectionNotes] = useState<Record<string, string>>(() =>
    editor.kind === "collection" ? editor.artworkNotes : {},
  );
  const [coverArtworkId, setCoverArtworkId] = useState<string | null>(() =>
    editor.kind === "collection" ? editor.coverArtworkId : null,
  );
  const [name, setName] = useState(editor.name);
  const [description, setDescription] = useState(() =>
    editor.kind === "collection" ? (editor.description ?? "") : "",
  );
  const [search, setSearch] = useState("");
  const [artworkType, setArtworkType] = useState("all");
  const [draggedArtworkId, setDraggedArtworkId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState(() => serializeDraft(initialSnapshot(editor)));
  const [closeRequested, setCloseRequested] = useState(false);

  const archiveById = useMemo(
    () => new Map(archive.map((artwork) => [artwork.id, artwork])),
    [archive],
  );
  const typeOptions = useMemo(
    () => [...new Set(archive.map((artwork) => artwork.artworkType))].sort(),
    [archive],
  );
  const filteredArchive = useMemo(() => {
    const query = search.trim().toLowerCase();
    return archive.filter(
      (artwork) =>
        (artworkType === "all" || artwork.artworkType === artworkType) &&
        (!query ||
          [artwork.title, artwork.artist].some((value) => value?.toLowerCase().includes(query))),
    );
  }, [archive, artworkType, search]);

  const currentSnapshot = useMemo(() => {
    const artworkIds = editor.kind === "collection" ? selectedOrder : [...selectedIds].sort();
    return serializeDraft({
      kind: editor.kind,
      name: editor.kind === "collection" ? name.trim() : editor.name,
      description: editor.kind === "collection" ? description.trim() : "",
      artworkIds,
      notes:
        editor.kind === "collection"
          ? Object.fromEntries(artworkIds.map((id) => [id, collectionNotes[id]?.trim() ?? ""]))
          : {},
      coverArtworkId: editor.kind === "collection" ? coverArtworkId : null,
    });
  }, [collectionNotes, coverArtworkId, description, editor, name, selectedIds, selectedOrder]);
  const isDirty = currentSnapshot !== baseline;
  const isSaving = saveCollection.isPending || setVisitArtworks.isPending;
  const shouldBlockNavigation = useCallback(() => isDirty, [isDirty]);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlockNavigation,
    enableBeforeUnload: isDirty,
    disabled: !isDirty,
    withResolver: true,
  });
  const discardOpen = closeRequested || blocker.status === "blocked";

  const toggleArtwork = (artworkId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(artworkId)) {
        next.delete(artworkId);
      } else {
        next.add(artworkId);
      }
      return next;
    });
    setSelectedOrder((current) =>
      current.includes(artworkId)
        ? current.filter((id) => id !== artworkId)
        : [...current, artworkId],
    );
    if (coverArtworkId === artworkId) setCoverArtworkId(null);
  };

  const moveArtwork = (artworkId: string, overArtworkId: string) => {
    if (artworkId === overArtworkId) return;
    setSelectedOrder((current) => {
      const from = current.indexOf(artworkId);
      const to = current.indexOf(overArtworkId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, artworkId);
      return next;
    });
  };

  const moveArtworkBy = (artworkId: string, offset: number) => {
    setSelectedOrder((current) => {
      const from = current.indexOf(artworkId);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(to, 0, moved);
      return next;
    });
  };

  const save = async () => {
    try {
      if (editor.kind === "collection") {
        await saveCollection.mutateAsync({
          collectionId: editor.id,
          name: name.trim() || editor.name,
          description: description.trim() || null,
          artworkIds: selectedOrder,
          notes: Object.fromEntries(
            selectedOrder.map((id) => [id, collectionNotes[id]?.trim() ?? ""]),
          ),
          coverArtworkId,
        });
      } else {
        await setVisitArtworks.mutateAsync({
          visitId: editor.id,
          artworkIds: [...selectedIds],
        });
      }
      await onSaved(editor.kind);
      setBaseline(currentSnapshot);
      toast.success(editor.kind === "collection" ? "Collection saved" : "Visit saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Changes could not be saved");
    }
  };

  const requestClose = () => {
    if (isDirty) setCloseRequested(true);
    else onClose();
  };

  const keepEditing = () => {
    setCloseRequested(false);
    if (blocker.status === "blocked") blocker.reset();
  };

  const discardChanges = () => {
    setCloseRequested(false);
    if (blocker.status === "blocked") blocker.proceed();
    else onClose();
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent
          showClose={false}
          className="inset-x-0 top-auto bottom-0 left-0 h-[min(92dvh,56rem)] max-h-none w-full max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden border-x-0 border-b-0 p-0 transition-[transform,opacity] duration-200 data-[ending-style]:translate-y-full data-[ending-style]:scale-100 data-[starting-style]:translate-y-full data-[starting-style]:scale-100 motion-reduce:transition-none sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:h-[min(88dvh,56rem)] sm:w-[calc(100%-3rem)] sm:max-w-6xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:border sm:data-[ending-style]:translate-y-[calc(-50%+1rem)] sm:data-[starting-style]:translate-y-[calc(-50%+1rem)]"
        >
          <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-5 sm:px-7">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <DialogTitle className="truncate text-xl tracking-tight">
                  {editor.kind === "collection" ? name || editor.name : editor.name}
                </DialogTitle>
                <DialogDescription className="mt-1">
                  {editor.kind === "collection"
                    ? "Sequence the exhibition, choose its cover, and add private notes."
                    : "Connect artworks from your archive to this visit."}
                </DialogDescription>
              </div>
              <p
                className={cn(
                  "flex items-center gap-2 text-xs",
                  isDirty ? "font-medium text-foreground" : "text-muted-foreground",
                )}
                aria-live="polite"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    isDirty ? "bg-foreground" : "bg-muted-foreground/40",
                  )}
                />
                {isDirty ? "Unsaved changes" : "All changes saved"}
              </p>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">
            {editor.kind === "collection" ? (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
                <div className="flex min-w-0 flex-col gap-6">
                  <section className="grid gap-4 rounded-2xl bg-card p-5 sm:grid-cols-2">
                    <label htmlFor="collection-name" className="flex flex-col gap-1.5 text-sm">
                      <span className="text-xs font-medium">Collection name</span>
                      <Input
                        name="collection-name"
                        id="collection-name"
                        autoComplete="off"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label
                      htmlFor="collection-description"
                      className="flex flex-col gap-1.5 text-sm"
                    >
                      <span className="text-xs font-medium">Description</span>
                      <Input
                        name="collection-description"
                        id="collection-description"
                        autoComplete="off"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                      />
                    </label>
                    <div className="flex items-start gap-3 pt-1 sm:col-span-2">
                      <LockKeyhole
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-sm font-medium">Private collection</p>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                          Publishing is unavailable. Only your account can open this exhibition.
                        </p>
                      </div>
                    </div>
                  </section>

                  <section aria-labelledby="sequence-heading">
                    <div className="flex items-end justify-between gap-4">
                      <div>
                        <h3 id="sequence-heading" className="text-sm font-medium">
                          Exhibition sequence
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Drag the handle or use the arrow buttons to reorder works.
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {selectedOrder.length} selected
                      </span>
                    </div>
                    {selectedOrder.length > 0 ? (
                      <ul className="mt-4 grid gap-2">
                        {selectedOrder.map((artworkId, index) => {
                          const artwork = archiveById.get(artworkId);
                          if (!artwork) return null;
                          const noteId = `collection-note-${artworkId}`;
                          return (
                            <li
                              key={artworkId}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={() => {
                                if (draggedArtworkId) moveArtwork(draggedArtworkId, artworkId);
                                setDraggedArtworkId(null);
                              }}
                              className="grid gap-3 rounded-2xl bg-card p-3 sm:grid-cols-[auto_3.5rem_minmax(0,1fr)_auto] sm:items-center"
                            >
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  draggable
                                  onDragStart={() => setDraggedArtworkId(artworkId)}
                                  onDragEnd={() => setDraggedArtworkId(null)}
                                  className="inline-flex size-8 cursor-grab items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:cursor-grabbing"
                                  aria-label={`Drag ${artwork.title} to reorder`}
                                >
                                  <GripVertical className="size-4" aria-hidden="true" />
                                </button>
                                <span className="w-6 text-center text-xs font-medium tabular-nums">
                                  {index + 1}
                                </span>
                              </div>
                              <div className="aspect-square overflow-hidden rounded-lg bg-secondary">
                                {artwork.thumbnailUrl || artwork.originalUrl ? (
                                  <img
                                    src={artwork.thumbnailUrl ?? artwork.originalUrl ?? undefined}
                                    alt=""
                                    width={artwork.width ?? undefined}
                                    height={artwork.height ?? undefined}
                                    className="size-full object-cover"
                                    loading="lazy"
                                  />
                                ) : (
                                  <ImageIcon
                                    className="m-auto size-4 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{artwork.title}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {artwork.artist ?? "Unknown artist"}
                                </p>
                                <Label htmlFor={noteId} className="sr-only">
                                  Curatorial note for {artwork.title}
                                </Label>
                                <Textarea
                                  id={noteId}
                                  name={noteId}
                                  maxLength={1_000}
                                  rows={2}
                                  value={collectionNotes[artworkId] ?? ""}
                                  onChange={(event) =>
                                    setCollectionNotes((current) => ({
                                      ...current,
                                      [artworkId]: event.target.value,
                                    }))
                                  }
                                  placeholder="Add a private curatorial note…"
                                  className="mt-2 min-h-16 resize-y text-xs"
                                />
                              </div>
                              <div className="flex items-center gap-1 sm:flex-col">
                                <label className="mb-1 flex items-center gap-2 text-xs">
                                  <input
                                    type="radio"
                                    className="size-3.5 accent-foreground"
                                    name="collection-cover"
                                    checked={coverArtworkId === artworkId}
                                    onChange={() => setCoverArtworkId(artworkId)}
                                  />
                                  Cover
                                </label>
                                <div className="flex gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => moveArtworkBy(artworkId, -1)}
                                    disabled={index === 0}
                                    aria-label={`Move ${artwork.title} up`}
                                  >
                                    <ArrowUp />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => moveArtworkBy(artworkId, 1)}
                                    disabled={index === selectedOrder.length - 1}
                                    aria-label={`Move ${artwork.title} down`}
                                  >
                                    <ArrowDown />
                                  </Button>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="mt-4 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                        Choose works from your archive to begin the exhibition.
                      </p>
                    )}
                  </section>
                </div>

                <ArchivePicker
                  archive={filteredArchive}
                  selectedIds={selectedIds}
                  selectedOrder={selectedOrder}
                  search={search}
                  onSearch={setSearch}
                  artworkType={artworkType}
                  onArtworkType={setArtworkType}
                  typeOptions={typeOptions}
                  onToggle={toggleArtwork}
                />
              </div>
            ) : (
              <ArchivePicker
                archive={archive}
                selectedIds={selectedIds}
                selectedOrder={[...selectedIds]}
                onToggle={toggleArtwork}
              />
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-border/60 bg-background px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-7 sm:py-4">
            <Button variant="ghost" onClick={requestClose} disabled={isSaving}>
              Close
            </Button>
            <Button
              onClick={() => void save()}
              disabled={isSaving || !isDirty || (editor.kind === "collection" && !name.trim())}
            >
              {isSaving ? "Saving…" : `Save ${selectedIds.size} works`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discardOpen} onOpenChange={(open) => !open && keepEditing()}>
        <DialogContent className="max-w-sm" showClose={false}>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your latest curation, notes, and cover choice have not been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={discardChanges}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ArchivePicker({
  archive,
  selectedIds,
  selectedOrder,
  onToggle,
  search,
  onSearch,
  artworkType,
  onArtworkType,
  typeOptions = [],
}: {
  archive: JournalArtwork[];
  selectedIds: Set<string>;
  selectedOrder: string[];
  onToggle: (artworkId: string) => void;
  search?: string;
  onSearch?: (value: string) => void;
  artworkType?: string;
  onArtworkType?: (value: string) => void;
  typeOptions?: string[];
}) {
  const orderById = useMemo(
    () => new Map(selectedOrder.map((id, index) => [id, index + 1])),
    [selectedOrder],
  );
  return (
    <section
      aria-labelledby="archive-picker-heading"
      className="min-w-0 lg:sticky lg:top-0 lg:self-start"
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 id="archive-picker-heading" className="text-sm font-medium">
            Your archive
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Select every work that belongs in this exhibition.
          </p>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{archive.length} shown</span>
      </div>
      {onSearch && onArtworkType ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_10rem]">
          <label htmlFor="collection-search" className="relative">
            <span className="sr-only">Search your archive</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              name="collection-search"
              id="collection-search"
              autoComplete="off"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search your archive…"
              className="pl-9"
            />
          </label>
          <label htmlFor="collection-type">
            <span className="sr-only">Filter by artwork type</span>
            <select
              className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/20"
              id="collection-type"
              value={artworkType}
              onChange={(event) => onArtworkType(event.target.value)}
            >
              <option value="all">All work types</option>
              {typeOptions.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div className="mt-4 grid max-h-[50dvh] grid-cols-2 gap-3 overflow-y-auto overscroll-contain pr-1 sm:grid-cols-3 lg:max-h-[62dvh] lg:grid-cols-2">
        {archive.map((artwork) => {
          const selected = selectedIds.has(artwork.id);
          return (
            <button
              key={artwork.id}
              type="button"
              onClick={() => onToggle(artwork.id)}
              aria-pressed={selected}
              className={cn(
                "group relative rounded-xl p-2 text-left transition-[background-color,transform] duration-150 outline-none [contain-intrinsic-size:auto_14rem] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.98] motion-reduce:active:scale-100",
                selected ? "bg-secondary text-foreground" : "bg-card hover:bg-secondary/60",
              )}
            >
              <div className="aspect-[4/3] overflow-hidden rounded-lg bg-secondary">
                {artwork.thumbnailUrl || artwork.originalUrl ? (
                  <img
                    src={artwork.thumbnailUrl ?? artwork.originalUrl ?? undefined}
                    alt=""
                    width={artwork.width ?? undefined}
                    height={artwork.height ?? undefined}
                    loading="lazy"
                    className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transition-none"
                  />
                ) : (
                  <div className="grid size-full place-items-center">
                    <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
                  </div>
                )}
              </div>
              <div className="px-1 pt-2 pr-9">
                <p className="truncate text-sm font-medium">{artwork.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {artwork.artist ?? "Unknown artist"}
                </p>
              </div>
              <span
                className={cn(
                  "absolute right-3 bottom-3 grid size-6 place-items-center rounded-full text-xs tabular-nums",
                  selected
                    ? "bg-foreground text-background"
                    : "bg-background text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {selected ? (orderById.get(artwork.id) ?? <Check className="size-3" />) : "+"}
              </span>
            </button>
          );
        })}
      </div>
      {archive.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
          No works match this search.
        </p>
      ) : null}
    </section>
  );
}
