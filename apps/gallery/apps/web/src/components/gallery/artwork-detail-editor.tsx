import { env } from "@aqt-gallery/env/web";
import { Button } from "@aqt-gallery/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aqt-gallery/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aqt-gallery/ui/components/dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Pencil, Plus, Save, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

import { ArtistDialog, type ArtistRow } from "./artist-dialog";
import type { ArtworkType } from "./types";

type CustomField = {
  id: string;
  label: string;
  value: string;
  position: number;
};

export function ArtworkDetailEditor({ artworkId }: { artworkId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery(trpc.artworks.get.queryOptions({ id: artworkId }));
  const updateArtwork = useMutation(trpc.artworks.update.mutationOptions());
  const setCustomFields = useMutation(trpc.artworks.setCustomFields.mutationOptions());
  const setTags = useMutation(trpc.tags.setArtworkTags.mutationOptions());
  const deleteArtwork = useMutation(trpc.artworks.delete.mutationOptions());
  const artists = useQuery(trpc.artists.list.queryOptions());
  const [form, setForm] = useState({
    title: "",
    artist: "",
    artistId: "",
    artworkType: "other" as ArtworkType,
    year: "",
    medium: "",
    dimensions: "",
    seenAt: "",
    rating: 0,
    review: "",
    thoughts: "",
    description: "",
    story: "",
    funFacts: "",
    sourceUrl: "",
    tags: "",
  });
  const [customFields, setCustomFieldState] = useState<CustomField[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [artistDialog, setArtistDialog] = useState<{
    open: boolean;
    artist: ArtistRow | null;
  }>({ open: false, artist: null });
  const image = detail.data?.image;
  const imageUrl = image ? `${env.VITE_SERVER_URL}${image.originalUrl}` : null;

  useEffect(() => {
    const data = detail.data;
    if (!data) {
      return;
    }
    setForm({
      title: data.artwork.title,
      artist: data.artwork.artist ?? "",
      artistId: data.artwork.artistId ?? "",
      artworkType: data.artwork.artworkType as ArtworkType,
      year: data.artwork.year ?? "",
      medium: data.artwork.medium ?? "",
      dimensions: data.artwork.dimensions ?? "",
      seenAt: data.artwork.seenAt ? new Date(data.artwork.seenAt).toISOString().slice(0, 10) : "",
      rating: data.artwork.rating ?? 0,
      review: data.artwork.review ?? "",
      thoughts: data.artwork.thoughts ?? "",
      description: data.artwork.description ?? "",
      story: data.artwork.story ?? "",
      funFacts: (data.artwork.funFacts ?? []).join("\n"),
      sourceUrl: data.artwork.sourceUrl ?? "",
      tags: data.tags.map((tag) => tag.name).join(", "),
    });
    setCustomFieldState(
      data.customFields.map((field) => ({
        id: crypto.randomUUID(),
        label: field.label,
        value: field.value,
        position: field.position,
      })),
    );
  }, [detail.data]);

  const customFieldsWithPositions = useMemo(
    () => customFields.map((field, index) => ({ ...field, position: index })),
    [customFields],
  );

  const artistList = artists.data ?? [];
  const linkedArtist = artistList.find((entry) => entry.id === form.artistId) ?? null;

  if (detail.isLoading) {
    return <div className="gallery-empty-state">Loading artwork...</div>;
  }

  if (!detail.data) {
    return (
      <div className="gallery-empty-state">
        <h1>Artwork not found.</h1>
        <Link to="/dashboard">Return to archive</Link>
      </div>
    );
  }

  const save = async () => {
    await updateArtwork.mutateAsync({
      id: artworkId,
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
      fields: customFieldsWithPositions.filter((field) => field.label),
    });
    await setTags.mutateAsync({
      artworkId,
      tagNames: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
    await queryClient.invalidateQueries();
    toast.success("Artwork saved");
  };

  const remove = async () => {
    await deleteArtwork.mutateAsync({ id: artworkId });
    setConfirmDelete(false);
    await queryClient.invalidateQueries();
    toast.success("Artwork deleted");
    navigate({ to: "/dashboard" });
  };

  return (
    <div className="artwork-detail-layout">
      <section className="artwork-detail-preview">
        {imageUrl ? (
          <img src={imageUrl} alt={form.title} />
        ) : (
          <div className="artwork-tile-empty">No image</div>
        )}
      </section>
      <aside className="artwork-detail-sidebar">
        <section className="detail-panel">
          <div className="detail-panel-heading">
            <h1>{form.title || "Untitled artwork"}</h1>
            <button
              className="gallery-primary-button gallery-save-button"
              type="button"
              onClick={save}
            >
              <Save size={15} />
              Save
            </button>
          </div>
          <div className="detail-form-grid">
            <label className="gallery-field">
              <span>Title</span>
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </label>
            <label className="gallery-field">
              <span>Artist</span>
              <input
                value={form.artist}
                onChange={(event) => setForm({ ...form, artist: event.target.value })}
              />
            </label>
            <label className="gallery-field">
              <span>Type</span>
              <select
                value={form.artworkType}
                onChange={(event) =>
                  setForm({
                    ...form,
                    artworkType: event.target.value as ArtworkType,
                  })
                }
              >
                <option value="painting">Painting</option>
                <option value="photo">Photo</option>
                <option value="sculpture">Sculpture</option>
                <option value="print">Print</option>
                <option value="object">Object</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="gallery-field">
              <span>Year</span>
              <input
                value={form.year}
                onChange={(event) => setForm({ ...form, year: event.target.value })}
              />
            </label>
            <label className="gallery-field">
              <span>Medium</span>
              <input
                value={form.medium}
                placeholder="Oil on canvas"
                onChange={(event) => setForm({ ...form, medium: event.target.value })}
              />
            </label>
            <label className="gallery-field">
              <span>Dimensions</span>
              <input
                value={form.dimensions}
                placeholder="73.7 × 92.1 cm"
                onChange={(event) => setForm({ ...form, dimensions: event.target.value })}
              />
            </label>
            <label className="gallery-field">
              <span>Seen</span>
              <input
                type="date"
                value={form.seenAt}
                onChange={(event) => setForm({ ...form, seenAt: event.target.value })}
              />
            </label>
            <label className="gallery-field">
              <span>Rating</span>
              <input
                type="number"
                min="0"
                max="5"
                value={form.rating}
                onChange={(event) => setForm({ ...form, rating: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="gallery-field">
            <span>Linked artist — bio &amp; dates on the museum wall</span>
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                  <UserRound />
                  {linkedArtist ? linkedArtist.name : "No linked artist"}
                  <ChevronDown className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 min-w-56">
                  <DropdownMenuRadioGroup
                    value={form.artistId || "none"}
                    onValueChange={(value) =>
                      setForm({
                        ...form,
                        artistId: value === "none" ? "" : value,
                      })
                    }
                  >
                    <DropdownMenuRadioItem value="none">No linked artist</DropdownMenuRadioItem>
                    {artistList.map((entry) => (
                      <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                        {entry.name}
                        {entry.userId ? "" : " · built-in"}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setArtistDialog({ open: true, artist: null })}>
                    <Plus />
                    Create new artist…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {linkedArtist?.userId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Edit linked artist"
                  onClick={() => setArtistDialog({ open: true, artist: linkedArtist })}
                >
                  <Pencil />
                </Button>
              ) : null}
            </div>
            {linkedArtist ? (
              <p className="text-[12px] text-white/45">
                {[
                  linkedArtist.nationality,
                  [linkedArtist.birthYear, linkedArtist.deathYear].filter(Boolean).join("–"),
                ]
                  .filter(Boolean)
                  .join(" · ") || "Linked"}
              </p>
            ) : null}
          </div>
          <label className="gallery-field">
            <span>Tags</span>
            <input
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
            />
          </label>
          <label className="gallery-field">
            <span>Description</span>
            <textarea
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>
          <label className="gallery-field">
            <span>Story — wall label shown to visitors</span>
            <textarea
              value={form.story}
              placeholder="A short, engaging narrative shown beside the work in the 3D museum."
              onChange={(event) => setForm({ ...form, story: event.target.value })}
            />
          </label>
          <label className="gallery-field">
            <span>Fun facts — one per line</span>
            <textarea
              value={form.funFacts}
              placeholder={"Painted in a single sitting.\nIts blue pigment was newly imported."}
              onChange={(event) => setForm({ ...form, funFacts: event.target.value })}
            />
          </label>
          <label className="gallery-field">
            <span>Review</span>
            <textarea
              value={form.review}
              onChange={(event) => setForm({ ...form, review: event.target.value })}
            />
          </label>
          <label className="gallery-field">
            <span>Thoughts</span>
            <textarea
              value={form.thoughts}
              onChange={(event) => setForm({ ...form, thoughts: event.target.value })}
            />
          </label>
        </section>
        <section className="detail-panel">
          <div className="detail-panel-heading">
            <h2>Custom fields</h2>
            <button
              aria-label="Add custom field"
              className="gallery-icon-button"
              type="button"
              onClick={() =>
                setCustomFieldState([
                  ...customFields,
                  {
                    id: crypto.randomUUID(),
                    label: "",
                    value: "",
                    position: customFields.length,
                  },
                ])
              }
            >
              <Plus size={16} />
            </button>
          </div>
          {customFields.map((field, index) => (
            <div className="custom-field-row" key={field.id}>
              <input
                aria-label="Custom field label"
                value={field.label}
                placeholder="Label"
                onChange={(event) => {
                  const next = [...customFields];
                  next[index] = { ...field, label: event.target.value };
                  setCustomFieldState(next);
                }}
              />
              <input
                aria-label="Custom field value"
                value={field.value}
                placeholder="Value"
                onChange={(event) => {
                  const next = [...customFields];
                  next[index] = { ...field, value: event.target.value };
                  setCustomFieldState(next);
                }}
              />
              <button
                aria-label="Remove custom field"
                className="gallery-icon-button"
                type="button"
                onClick={() =>
                  setCustomFieldState(customFields.filter((_, fieldIndex) => fieldIndex !== index))
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </section>
        <section className="detail-panel">
          <div className="detail-panel-heading">
            <h2>Danger zone</h2>
          </div>
          <p className="mt-3 text-[13px] text-white/55 leading-relaxed">
            Permanently delete this artwork from your archive. It is also removed from any galleries
            it hangs in. This can't be undone.
          </p>
          <Button
            type="button"
            variant="destructive"
            className="mt-3"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={15} />
            Delete artwork
          </Button>
        </section>
      </aside>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this artwork?</DialogTitle>
            <DialogDescription>
              “{form.title || "Untitled artwork"}” will be permanently removed from your archive and
              any galleries it hangs in. This can't be undone.
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
        onCreated={(id) => setForm((prev) => ({ ...prev, artistId: id }))}
        onDeleted={(id) =>
          setForm((prev) => (prev.artistId === id ? { ...prev, artistId: "" } : prev))
        }
      />
    </div>
  );
}
