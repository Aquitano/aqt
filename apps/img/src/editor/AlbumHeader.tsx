import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, Copy, Link2, Pencil } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { albumQuery, albumsQuery } from "@/lib/queries";
import * as albumFns from "@/server/fns/albums";
import * as shareFns from "@/server/fns/share";

import { useEditor } from "./store";

type AlbumHeaderProps = {
  canEdit: boolean;
};

/** Slim bar above the book: back, title, sharing, edit toggle. */
export function AlbumHeader({ canEdit }: AlbumHeaderProps) {
  const mode = useEditor((state) => state.mode);
  const setMode = useEditor((state) => state.setMode);
  return (
    <header className="flex items-center gap-2 px-4 py-3">
      <Button variant="ghost" size="icon" asChild aria-label="Back to albums">
        <Link to="/albums">
          <ChevronLeft />
        </Link>
      </Button>
      <Title />
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        {canEdit ? <SharePopover /> : null}
        {canEdit ? (
          <Button
            variant={mode === "edit" ? "secondary" : "default"}
            size="sm"
            onClick={() => setMode(mode === "edit" ? "view" : "edit")}
          >
            {mode === "edit" ? (
              <Check data-icon="inline-start" />
            ) : (
              <Pencil data-icon="inline-start" />
            )}
            {mode === "edit" ? "Done" : "Edit"}
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function Title() {
  const album = useEditor((state) => state.album);
  const updateAlbum = useEditor((state) => state.updateAlbum);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (title: string) => albumFns.update({ data: { albumId: album.id, title } }),
    onSuccess: () => {
      void queryClient.invalidateQueries(albumsQuery());
      void queryClient.invalidateQueries(albumQuery(album.id));
    },
    onError: () => toast.error("Could not rename the album"),
  });

  const commit = () => {
    const title = draft?.trim();
    setDraft(null);
    if (!title || title === album.title) return;
    updateAlbum({ title });
    rename.mutate(title);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setDraft(null);
  };

  if (draft !== null) {
    return (
      <Input
        autoFocus
        aria-label="Album title"
        value={draft}
        className="h-8 max-w-xs"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <button
      type="button"
      className="truncate rounded-md px-2 py-1 text-lg font-medium hover:bg-accent"
      onClick={() => setDraft(album.title)}
      title="Rename"
    >
      {album.title}
    </button>
  );
}

function SharePopover() {
  const album = useEditor((state) => state.album);
  const updateAlbum = useEditor((state) => state.updateAlbum);
  const queryClient = useQueryClient();
  const slug = album.shareSlug;
  const url = slug && typeof window !== "undefined" ? `${window.location.origin}/s/${slug}` : "";

  const toggle = useMutation({
    mutationFn: async (enable: boolean) => {
      if (enable) return (await shareFns.enable({ data: { albumId: album.id } })).slug;
      await shareFns.disable({ data: { albumId: album.id } });
      return null;
    },
    onSuccess: (shareSlug) => {
      updateAlbum({ shareSlug });
      void queryClient.invalidateQueries(albumQuery(album.id));
    },
    onError: () => toast.error("Could not change sharing"),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy the link. Select it and copy by hand.");
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Link2 data-icon="inline-start" />
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="share-switch">Share with a link</Label>
            <p className="text-xs text-muted-foreground">
              Anyone with the link can flip through, not edit.
            </p>
          </div>
          <Switch
            id="share-switch"
            checked={slug !== null}
            disabled={toggle.isPending}
            onCheckedChange={(checked) => toggle.mutate(checked)}
          />
        </div>
        {slug ? (
          <div className="flex gap-2">
            <Input
              readOnly
              value={url}
              aria-label="Share link"
              data-testid="share-url"
              className="h-8"
            />
            <Button variant="outline" size="icon-sm" aria-label="Copy link" onClick={copy}>
              <Copy />
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
