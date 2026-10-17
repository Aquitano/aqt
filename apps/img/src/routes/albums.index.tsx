import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardFooter } from "@aqt/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@aqt/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aqt/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@aqt/ui/components/empty";
import { Input } from "@aqt/ui/components/input";
import { Label } from "@aqt/ui/components/label";
import { ThemeToggle } from "@aqt/ui/components/theme-toggle";
import { ToggleGroup, ToggleGroupItem } from "@aqt/ui/components/toggle-group";
import { UserButton } from "@clerk/tanstack-react-start";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ShelfCover } from "@/book/Cover";
import {
  COVER_COLOR_NAMES,
  COVER_COLORS,
  COVER_MATERIALS,
  type CoverColorName,
} from "@/book/palette";
import { ApiKeysDialog } from "@/components/api-keys-dialog";
import { coverMaterial, type CoverMaterial } from "@/domain/element";
import { requireSignedIn } from "@/lib/guard";
import { albumsQuery } from "@/lib/queries";
import { rejectFailures } from "@/lib/server-error";
import { cn } from "@/lib/utils";
import type { Album } from "@/server/db/schema";
import * as albumFns from "@/server/fns/albums";

export const Route = createFileRoute("/albums/")({
  beforeLoad: requireSignedIn,
  loader: ({ context }) => context.queryClient.ensureQueryData(albumsQuery()),
  component: Shelf,
});

function Shelf() {
  const { data: albums } = useSuspenseQuery(albumsQuery());
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<Album | null>(null);

  const remove = useMutation({
    mutationFn: (albumId: string) => rejectFailures(albumFns.remove({ data: { albumId } })),
    onSuccess: () => queryClient.invalidateQueries(albumsQuery()),
    onError: () => toast.error("Could not delete that album"),
  });

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <ApiKeysDialog />
          <CreateAlbumDialog />
          <UserButton />
        </div>
      </header>

      {albums.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No albums yet</EmptyTitle>
            <EmptyDescription>Create one to start placing photos on pages.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
          {albums.map((album) => (
            <Card key={album.id} className="overflow-hidden pt-0">
              <Link to="/albums/$albumId" params={{ albumId: album.id }} className="block">
                <CardContent className="bg-muted/40 px-8 pt-8 pb-6">
                  <ShelfCover cover={album.cover} title={album.title} />
                </CardContent>
              </Link>
              <CardFooter className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{album.title}</p>
                  <p className="text-xs text-muted-foreground capitalize">{album.cover.material}</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Actions for ${album.title}`}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(album)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{pendingDelete?.title}"?</DialogTitle>
            <DialogDescription>
              The album and every page in it go for good. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function CreateAlbumDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [material, setMaterial] = useState<CoverMaterial>("linen");
  const [color, setColor] = useState<CoverColorName>("oxblood");

  const create = useMutation({
    mutationFn: () =>
      rejectFailures(
        albumFns.create({
          data: { title: title.trim(), cover: { material, color: COVER_COLORS[color] } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries(albumsQuery());
      setOpen(false);
      setTitle("");
    },
    onError: () => toast.error("Could not create that album"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus /> New album
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New album</DialogTitle>
          <DialogDescription>Pick a name and a cover.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-2">
          <div className="grid gap-2">
            <Label htmlFor="album-title">Title</Label>
            <Input
              id="album-title"
              value={title}
              autoFocus
              placeholder="Summer 2026"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label>Material</Label>
            <ToggleGroup
              variant="outline"
              value={[material]}
              onValueChange={([next]) => coverMaterial.allows(next) && setMaterial(next)}
            >
              {COVER_MATERIALS.map((value) => (
                <ToggleGroupItem key={value} value={value} className="capitalize">
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="grid gap-2">
            <Label>Colour</Label>
            <div className="flex gap-2">
              {COVER_COLOR_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-label={name}
                  aria-pressed={color === name}
                  onClick={() => setColor(name)}
                  style={{ background: COVER_COLORS[name] }}
                  className={cn(
                    "size-8 rounded-full border transition-all",
                    color === name && "ring-2 ring-ring ring-offset-2",
                  )}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={title.trim().length === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
