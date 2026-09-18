import { Button } from "@aqt/gallery-ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aqt/gallery-ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aqt/gallery-ui/components/dropdown-menu";
import { Input } from "@aqt/gallery-ui/components/input";
import { Label } from "@aqt/gallery-ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LandPlot, Shapes, Tag, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

import type { ArtworkCard, ArtworkType } from "./types";
import { isCurated } from "./use-exhibition-curation";

const TYPES: { value: ArtworkType; label: string }[] = [
  { value: "painting", label: "Painting" },
  { value: "photo", label: "Photo" },
  { value: "sculpture", label: "Sculpture" },
  { value: "print", label: "Print" },
  { value: "object", label: "Object" },
  { value: "other", label: "Other" },
];

/**
 * Floating toolbar for acting on a selection of artworks at once.
 * Type changes go through the batched `artworks.bulkUpdate` and hanging
 * through `exhibitions.appendRoomArtworks`; tagging and deletion fan out one
 * call per artwork (tags must merge with each work's existing set, and delete
 * has no batch endpoint). Another curator's work can only be hung, so the
 * editing actions disappear as soon as one is in the selection.
 */
export function BulkActionBar({
  selected,
  cards,
  onClear,
}: {
  selected: string[];
  cards: ArtworkCard[];
  onClear: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const bulkUpdate = useMutation(trpc.artworks.bulkUpdate.mutationOptions());
  const setTags = useMutation(trpc.tags.setArtworkTags.mutationOptions());
  const deleteArtwork = useMutation(trpc.artworks.delete.mutationOptions());
  const exhibitions = useQuery(trpc.exhibitions.mine.queryOptions());
  const appendToRoom = useMutation(trpc.exhibitions.appendRoomArtworks.mutationOptions());
  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const count = selected.length;
  const busy =
    bulkUpdate.isPending || setTags.isPending || deleteArtwork.isPending || appendToRoom.isPending;
  const selectedCards = cards.filter((card) => selected.includes(card.id));
  const editable = selectedCards.every((card) => card.isOwn);
  // One flat target per room: a one-room exhibition reads as itself, a
  // multi-room one lists each room.
  const roomTargets = (exhibitions.data ?? []).filter(isCurated).flatMap((e) =>
    e.rooms.map((room) => ({
      roomId: room.id,
      label: e.rooms.length === 1 ? e.name : `${e.name} · ${room.name}`,
    })),
  );

  const setType = async (artworkType: ArtworkType) => {
    await bulkUpdate.mutateAsync({
      artworks: selected.map((artworkId) => ({ artworkId, artworkType })),
    });
    await queryClient.invalidateQueries();
    toast.success(`Set type on ${count} ${count === 1 ? "work" : "works"}`);
    onClear();
  };

  const hangIn = async (target: { roomId: string; label: string }) => {
    await appendToRoom.mutateAsync({
      roomId: target.roomId,
      artworkIds: selected,
    });
    await queryClient.invalidateQueries();
    toast.success(`Hung ${count} ${count === 1 ? "work" : "works"} in ${target.label}`);
    onClear();
  };

  const addTag = async () => {
    const name = tagValue.trim();
    if (!name) return;
    // Merge the new tag into each work's existing set — setArtworkTags
    // replaces the whole list, so we must send the union. allSettled so one
    // failed write doesn't abort the rest or skip the cleanup below.
    const results = await Promise.allSettled(
      selectedCards.map((card) => {
        const names = card.tags.map((tag) => tag.name);
        if (names.some((existing) => existing.toLowerCase() === name.toLowerCase()))
          return Promise.resolve();
        return setTags.mutateAsync({
          artworkId: card.id,
          tagNames: [...names, name],
        });
      }),
    );
    await queryClient.invalidateQueries();
    setTagValue("");
    setTagOpen(false);
    onClear();
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      toast.success(`Tagged ${count} ${count === 1 ? "work" : "works"}`);
    } else {
      toast.error(`Tagged ${count - failed} of ${count}; ${failed} failed`);
    }
  };

  const removeSelected = async () => {
    // allSettled: a single failed delete must still clear the (now partially
    // deleted) selection and report the partial outcome, not leave stale state.
    const results = await Promise.allSettled(
      selected.map((artworkId) => deleteArtwork.mutateAsync({ artworkId })),
    );
    await queryClient.invalidateQueries();
    setConfirmDelete(false);
    onClear();
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      toast.success(`Deleted ${count} ${count === 1 ? "work" : "works"}`);
    } else {
      toast.error(`Deleted ${count - failed} of ${count}; ${failed} failed`);
    }
  };

  return (
    <>
      <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-popover/95 py-2 pr-2 pl-4 text-popover-foreground shadow-2xl backdrop-blur-md">
        <span className="px-1 text-sm font-medium tabular-nums">{count} selected</span>

        {editable ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>
                <Shapes />
                Set type
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="min-w-40">
                {TYPES.map((type) => (
                  <DropdownMenuItem key={type.value} onClick={() => void setType(type.value)}>
                    {type.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button variant="outline" size="sm" disabled={busy} onClick={() => setTagOpen(true)}>
              <Tag />
              Add tag
            </Button>
          </>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>
            <LandPlot />
            Add to exhibition
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="max-h-72 min-w-48">
            {roomTargets.length === 0 ? (
              <DropdownMenuItem disabled>No exhibitions yet</DropdownMenuItem>
            ) : (
              roomTargets.map((target) => (
                <DropdownMenuItem key={target.roomId} onClick={() => void hangIn(target)}>
                  {target.label}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {editable ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
            Delete
          </Button>
        ) : null}

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          disabled={busy}
          onClick={onClear}
        >
          <X />
        </Button>
      </div>

      <Dialog open={tagOpen} onOpenChange={setTagOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add a tag</DialogTitle>
            <DialogDescription>
              Adds this tag to {count} selected {count === 1 ? "work" : "works"}, keeping their
              existing tags.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-tag">Tag</Label>
            <Input
              id="bulk-tag"
              autoFocus
              value={tagValue}
              placeholder="e.g. Impressionism"
              onChange={(event) => setTagValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addTag();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTagOpen(false)} disabled={setTags.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => void addTag()}
              disabled={setTags.isPending || tagValue.trim().length === 0}
            >
              Add tag
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {count} {count === 1 ? "artwork" : "artworks"}?
            </DialogTitle>
            <DialogDescription>
              The selected {count === 1 ? "artwork" : "artworks"} will be permanently removed from
              your archive and any exhibitions they hang in. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteArtwork.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void removeSelected()}
              disabled={deleteArtwork.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
