import { useState } from 'react'
import { UserButton } from '@clerk/tanstack-react-start'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { ShelfCover } from '@/book/Cover'
import { COVER_COLORS, COVER_MATERIALS, type CoverColorName } from '@/book/palette'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { CoverMaterial } from '@/domain/element'
import { requireSignedIn } from '@/lib/guard'
import { albumsQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'
import * as albumFns from '@/server/fns/albums'

export const Route = createFileRoute('/albums/')({
  beforeLoad: requireSignedIn,
  loader: ({ context }) => context.queryClient.ensureQueryData(albumsQuery()),
  component: Shelf,
})

function Shelf() {
  const { data: albums } = useSuspenseQuery(albumsQuery())
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: (albumId: string) => albumFns.remove({ data: { albumId } }),
    onSuccess: () => queryClient.invalidateQueries(albumsQuery()),
    onError: () => toast.error('Could not delete that album'),
  })

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
        <div className="flex items-center gap-3">
          <CreateAlbumDialog />
          <UserButton />
        </div>
      </header>

      {albums.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No albums yet</EmptyTitle>
            <EmptyDescription>
              Create one to start placing photos on pages.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
          {albums.map((album) => (
            <Card key={album.id} className="overflow-hidden pt-0">
              <Link
                to="/albums/$albumId"
                params={{ albumId: album.id }}
                className="block"
              >
                <CardContent className="bg-muted/40 px-8 pt-8 pb-6">
                  <ShelfCover cover={album.cover} title={album.title} />
                </CardContent>
              </Link>
              <CardFooter className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{album.title}</p>
                  <p className="text-muted-foreground text-xs capitalize">
                    {album.cover.material}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for ${album.title}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => remove.mutate(album.id)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </main>
  )
}

function CreateAlbumDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [material, setMaterial] = useState<CoverMaterial>('linen')
  const [color, setColor] = useState<CoverColorName>('oxblood')

  const create = useMutation({
    mutationFn: () =>
      albumFns.create({
        data: { title: title.trim(), cover: { material, color: COVER_COLORS[color] } },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries(albumsQuery())
      setOpen(false)
      setTitle('')
    },
    onError: () => toast.error('Could not create that album'),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New album
        </Button>
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
              type="single"
              variant="outline"
              value={material}
              onValueChange={(next) => next && setMaterial(next as CoverMaterial)}
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
              {Object.entries(COVER_COLORS).map(([name, value]) => (
                <button
                  key={name}
                  type="button"
                  aria-label={name}
                  aria-pressed={color === name}
                  onClick={() => setColor(name as CoverColorName)}
                  style={{ background: value }}
                  className={cn(
                    'size-8 rounded-full border transition-all',
                    color === name && 'ring-ring ring-2 ring-offset-2',
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
  )
}
