import { env } from "@aqt/gallery-env/web";
import { Button } from "@aqt/gallery-ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aqt/gallery-ui/components/dialog";
import { Skeleton } from "@aqt/gallery-ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

import { ArtistDialog, type ArtistRow } from "./artist-dialog";
import { ArtworkEditor, type ArtworkFormValues, type CustomFieldRow } from "./artwork-editor";
import type { ArtworkType } from "./types";

type ArtworkDetail = {
  artwork: {
    title: string;
    artist: string | null;
    artistId: string | null;
    artworkType: string;
    year: string | null;
    medium: string | null;
    dimensions: string | null;
    seenAt: Date | string | null;
    rating: number | null;
    review: string | null;
    thoughts: string | null;
    description: string | null;
    story: string | null;
    funFacts: string[] | null;
    sourceUrl: string | null;
  };
  customFields: { label: string; value: string }[];
  tags: { name: string }[];
};

type Draft = { form: ArtworkFormValues; customFields: CustomFieldRow[] };

function toDraft(data: ArtworkDetail): Draft {
  const { artwork } = data;
  return {
    form: {
      title: artwork.title,
      artist: artwork.artist ?? "",
      artistId: artwork.artistId ?? "",
      artworkType: artwork.artworkType as ArtworkType,
      year: artwork.year ?? "",
      medium: artwork.medium ?? "",
      dimensions: artwork.dimensions ?? "",
      seenAt: artwork.seenAt ? new Date(artwork.seenAt).toISOString().slice(0, 10) : "",
      rating: artwork.rating ?? 0,
      review: artwork.review ?? "",
      thoughts: artwork.thoughts ?? "",
      description: artwork.description ?? "",
      story: artwork.story ?? "",
      funFacts: (artwork.funFacts ?? []).join("\n"),
      sourceUrl: artwork.sourceUrl ?? "",
      tags: data.tags.map((tag) => tag.name),
    },
    customFields: data.customFields.map((field) => ({
      id: crypto.randomUUID(),
      label: field.label,
      value: field.value,
    })),
  };
}

/** Row ids are client-only, so they must not count as a change. */
function fingerprint(draft: Draft) {
  return JSON.stringify({
    form: draft.form,
    customFields: draft.customFields.map(({ label, value }) => ({
      label,
      value,
    })),
  });
}

export function ArtworkDetailEditor({ artworkId }: { artworkId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery(trpc.artworks.get.queryOptions({ artworkId }));
  const artists = useQuery(trpc.artists.list.queryOptions());
  const updateArtwork = useMutation(trpc.artworks.update.mutationOptions());
  const setCustomFields = useMutation(trpc.artworks.setCustomFields.mutationOptions());
  const setTags = useMutation(trpc.tags.setArtworkTags.mutationOptions());
  const deleteArtwork = useMutation(trpc.artworks.delete.mutationOptions());

  // Seeded once per artwork: re-seeding on every `detail.data` change would
  // let a background refetch overwrite in-progress edits.
  const [draft, setDraft] = useState<(Draft & { forId: string }) | null>(null);
  const [saved, setSaved] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [artistDialog, setArtistDialog] = useState<{
    open: boolean;
    artist: ArtistRow | null;
  }>({ open: false, artist: null });

  const hydrate = (data: ArtworkDetail) => {
    const next = toDraft(data);
    setDraft({ ...next, forId: artworkId });
    setSaved(fingerprint(next));
  };

  useEffect(() => {
    if (detail.data && draft?.forId !== artworkId) hydrate(detail.data);
  }, [detail.data, artworkId, draft?.forId, hydrate]);

  const dirty = draft !== null && fingerprint(draft) !== saved;
  const saving = updateArtwork.isPending || setCustomFields.isPending || setTags.isPending;

  const save = async () => {
    // Ignore re-entrant calls so two save sequences can't interleave the
    // delete-then-insert tag/field writes.
    if (!draft || saving) return;
    const { form, customFields } = draft;
    try {
      await updateArtwork.mutateAsync({
        artworkId,
        title: form.title,
        artist: form.artist || null,
        artistId: form.artistId || null,
        artworkType: form.artworkType,
        year: form.year || null,
        medium: form.medium || null,
        dimensions: form.dimensions || null,
        seenAt: form.seenAt || null,
        rating: form.rating || null,
        review: form.review || null,
        thoughts: form.thoughts || null,
        description: form.description || null,
        story: form.story || null,
        funFacts: form.funFacts
          .split("\n")
          .map((fact) => fact.trim())
          .filter(Boolean),
        sourceUrl: form.sourceUrl || null,
      });
      await setCustomFields.mutateAsync({
        artworkId,
        fields: customFields
          .filter((field) => field.label.trim())
          .map((field, position) => ({
            label: field.label,
            value: field.value,
            position,
          })),
      });
      await setTags.mutateAsync({ artworkId, tagNames: form.tags });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save");
      return;
    }
    setSaved(fingerprint(draft));
    await Promise.all([
      queryClient.invalidateQueries(trpc.artworks.pathFilter()),
      queryClient.invalidateQueries(trpc.tags.pathFilter()),
      queryClient.invalidateQueries(trpc.exhibitions.pathFilter()),
    ]);
    toast.success("Artwork saved");
  };

  useEffect(() => {
    if (!dirty) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void save();
      }
    };
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
    };
  });

  const remove = async () => {
    await deleteArtwork.mutateAsync({ artworkId });
    setConfirmDelete(false);
    await Promise.all([
      queryClient.invalidateQueries(trpc.artworks.pathFilter()),
      queryClient.invalidateQueries(trpc.exhibitions.pathFilter()),
    ]);
    toast.success("Artwork deleted");
    await navigate({ to: "/explore" });
  };

  if (detail.isLoading || (detail.data && !draft)) {
    return <EditorSkeleton />;
  }

  if (!detail.data || !draft) {
    return (
      <div className="mx-auto max-w-md pt-32 text-center">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">
          This artwork isn't in your archive.
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
          Only the curator who imported a work can open and edit it here. It may belong to someone
          else, or it has been deleted.
        </p>
        <Button
          className="mt-6"
          variant="outline"
          nativeButton={false}
          render={<Link to="/explore" />}
        >
          <ArrowLeft />
          Back to explore
        </Button>
      </div>
    );
  }

  const image = detail.data.image;
  const asset = detail.data.mediaAssets[0];

  return (
    <>
      <ArtworkEditor
        image={
          image
            ? {
                url: `${env.VITE_SERVER_URL}${image.originalUrl}`,
                width: asset?.width ?? detail.data.artwork.imageWidth,
                height: asset?.height ?? detail.data.artwork.imageHeight,
              }
            : null
        }
        form={draft.form}
        onFormChange={(patch) =>
          setDraft((prev) => (prev ? { ...prev, form: { ...prev.form, ...patch } } : prev))
        }
        customFields={draft.customFields}
        onCustomFieldsChange={(customFields) =>
          setDraft((prev) => (prev ? { ...prev, customFields } : prev))
        }
        artists={artists.data ?? []}
        onEditArtist={(artist) => setArtistDialog({ open: true, artist })}
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => detail.data && hydrate(detail.data)}
        onDelete={() => setConfirmDelete(true)}
      />
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this artwork?</DialogTitle>
            <DialogDescription>
              “{draft.form.title || "Untitled artwork"}” will be permanently removed from your
              archive and any galleries it hangs in. This can't be undone.
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
              onClick={() => void remove()}
              disabled={deleteArtwork.isPending}
            >
              Delete artwork
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ArtistDialog
        open={artistDialog.open}
        onOpenChange={(open) => setArtistDialog((prev) => ({ ...prev, open }))}
        artist={artistDialog.artist}
        onCreated={(id) =>
          setDraft((prev) => (prev ? { ...prev, form: { ...prev.form, artistId: id } } : prev))
        }
        onDeleted={(id) =>
          setDraft((prev) =>
            prev && prev.form.artistId === id
              ? { ...prev, form: { ...prev.form, artistId: "" } }
              : prev,
          )
        }
      />
    </>
  );
}

function EditorSkeleton() {
  return (
    <div className="mx-auto grid max-w-[1480px] gap-10 pt-3 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)] lg:gap-16">
      <div className="flex min-h-[46svh] items-center justify-center lg:h-[calc(100svh-108px)]">
        <Skeleton className="aspect-[4/5] h-[70%] max-w-full" />
      </div>
      <div className="flex flex-col gap-4 pt-14">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-9 w-4/5" />
        <Skeleton className="mt-8 h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
