import { Button } from "@aqt/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aqt/ui/components/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@aqt/ui/components/sheet";
import { Skeleton } from "@aqt/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { toast } from "sonner";

import { photoUrl, resizePhoto } from "@/lib/image";
import { photosQuery } from "@/lib/queries";
import { ServerError, rejectFailures } from "@/lib/server-error";
import { cn } from "@/lib/utils";
import type { Photo } from "@/server/db/schema";
import * as photoFns from "@/server/fns/photos";

import { PHOTO_DRAG_TYPE } from "./EditablePage";
import { photoElementFor, targetPage, type PhotoRef } from "./place";
import { useEditor } from "./store";

type Upload = { key: string; name: string; status: "processing" | "uploading" };

/** Right-hand sheet: upload photos and place them on the open spread. */
export function PhotoLibrary() {
  const open = useEditor((state) => state.panel === "photos");
  const setPanel = useEditor((state) => state.setPanel);
  const spreads = useEditor((state) => state.spreads);
  const current = useEditor((state) => state.current);
  const selection = useEditor((state) => state.selection);
  const addElement = useEditor((state) => state.addElement);
  const select = useEditor((state) => state.select);
  const queryClient = useQueryClient();
  const photos = useQuery({ ...photosQuery(), enabled: open });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const remove = useMutation({
    mutationFn: async (photoId: string) => rejectFailures(photoFns.remove({ data: { photoId } })),
    onSuccess: () => queryClient.invalidateQueries(photosQuery()),
    onError: (error) =>
      toast.error(isConflict(error) ? error.message : "Could not delete that photo"),
  });

  const place = (photo: PhotoRef) => {
    const spread = spreads[current];
    if (!spread) return;
    const element = photoElementFor(photo, targetPage(spread.elements, selection));
    addElement(spread.id, element);
    select(element.id);
  };

  const upload = async (files: FileList | File[]) => {
    const all = Array.from(files);
    const list = all.filter((file) => file.type.startsWith("image/") || /\.heic$/i.test(file.name));
    const rejected = all.length - list.length;
    if (rejected > 0) {
      toast.error(
        rejected === 1 ? "That file is not an image" : `${rejected} files are not images`,
      );
    }
    await Promise.all(
      list.map(async (file) => {
        const key = `${file.name}-${Date.now()}-${Math.random()}`;
        setUploads((prev) => [...prev, { key, name: file.name, status: "processing" }]);
        try {
          const resized = await resizePhoto(file).catch(() => {
            throw new Error(
              /heic$/i.test(file.name)
                ? "HEIC photos are not supported in this browser"
                : `Could not read ${file.name}`,
            );
          });
          setUploads((prev) =>
            prev.map((u) => (u.key === key ? { ...u, status: "uploading" } : u)),
          );
          const photo = await rejectFailures(
            photoFns.create({ data: { width: resized.width, height: resized.height } }),
          );
          await Promise.all([
            put(photoUrl(photo.id, "display"), resized.display),
            put(photoUrl(photo.id, "thumb"), resized.thumb),
          ]);
          await queryClient.invalidateQueries(photosQuery());
        } catch (error) {
          toast.error(error instanceof Error ? error.message : `Could not upload ${file.name}`);
        } finally {
          setUploads((prev) => prev.filter((u) => u.key !== key));
        }
      }),
    );
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragOver(false);
    void upload(event.dataTransfer.files);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void upload(event.target.files);
    event.target.value = "";
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => setPanel(next ? "photos" : null)}
      modal={false}
      disablePointerDismissal
    >
      <SheetContent side="right" data-modeless className="data-[side=right]:w-full">
        <SheetHeader>
          <SheetTitle>Photos</SheetTitle>
          <SheetDescription>Click a photo to place it, or drag it onto a page.</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 pb-6">
          <label
            data-testid="dropzone"
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors",
              dragOver && "border-primary bg-accent",
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <Upload className="size-5" />
            <span>Drop photos here or click to choose</span>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,.heic"
              multiple
              className="sr-only"
              onChange={onPick}
              data-testid="photo-input"
            />
          </label>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {photos.data?.length === 0 && uploads.length === 0 ? (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ImagePlus />
                  </EmptyMedia>
                  <EmptyTitle>No photos yet</EmptyTitle>
                  <EmptyDescription>
                    Uploads land here and can be used in every album.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {uploads.map((item) => (
                  <Skeleton key={item.key} className="aspect-square" title={item.name} />
                ))}
                {photos.isPending
                  ? Array.from({ length: 6 }, (_, i) => (
                      <Skeleton key={i} className="aspect-square" />
                    ))
                  : photos.data?.map((photo) => (
                      <Thumb
                        key={photo.id}
                        photo={photo}
                        onPlace={() => place(photo)}
                        onDelete={() => remove.mutate(photo.id)}
                      />
                    ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Thumb({
  photo,
  onPlace,
  onDelete,
}: {
  photo: Photo;
  onPlace: () => void;
  onDelete: () => void;
}) {
  const ref: PhotoRef = { id: photo.id, width: photo.width, height: photo.height };
  return (
    <div className="group relative aspect-square overflow-hidden rounded-md">
      <button
        type="button"
        className="size-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={onPlace}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(PHOTO_DRAG_TYPE, JSON.stringify(ref));
          event.dataTransfer.effectAllowed = "copy";
        }}
        aria-label="Place photo"
        data-testid="library-photo"
      >
        <img
          src={photoUrl(photo.id, "thumb")}
          alt=""
          className="size-full object-cover"
          draggable={false}
        />
      </button>
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label="Delete photo"
        className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

async function put(url: string, blob: Blob) {
  const response = await fetch(url, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": blob.type || "image/jpeg" },
  });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
}

/** The server refuses to delete a photo that is still on a page. */
function isConflict(error: Error): error is ServerError {
  return error instanceof ServerError && error.status === 409;
}
