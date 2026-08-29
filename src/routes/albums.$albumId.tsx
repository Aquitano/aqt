import { useEffect, useMemo } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { Book } from '@/book/Book'
import { Button } from '@/components/ui/button'
import { attachAutosave } from '@/editor/autosave'
import {
  EditorStoreProvider,
  createEditorStore,
  useEditor,
} from '@/editor/store'
import { requireSignedIn } from '@/lib/guard'
import { albumQuery } from '@/lib/queries'

export const Route = createFileRoute('/albums/$albumId')({
  beforeLoad: requireSignedIn,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(albumQuery(params.albumId)),
  component: AlbumPage,
})

function AlbumPage() {
  const { albumId } = Route.useParams()
  const { data } = useSuspenseQuery(albumQuery(albumId))

  // One store per open album; recreated when the album identity changes.
  const store = useMemo(
    () => createEditorStore(data.album, data.spreads),
    [data.album.id],
  )

  useEffect(() => attachAutosave(store), [store])

  return (
    <EditorStoreProvider value={store}>
      <main className="flex h-dvh flex-col">
        <header className="flex items-center gap-3 px-6 py-4">
          <Button variant="ghost" size="icon" asChild aria-label="Back to albums">
            <Link to="/albums">
              <ChevronLeft />
            </Link>
          </Button>
          <h1 className="text-lg font-medium">{data.album.title}</h1>
        </header>

        {/* phase 3: Editor.tsx wraps this with the toolbar, sheets and handles. */}
        <div className="flex min-h-0 flex-1 px-6 pb-10">
          <BookView />
        </div>
      </main>
    </EditorStoreProvider>
  )
}

function BookView() {
  const album = useEditor((state) => state.album)
  const spreads = useEditor((state) => state.spreads)
  const current = useEditor((state) => state.current)
  const setCurrent = useEditor((state) => state.setCurrent)

  return (
    <Book
      title={album.title}
      cover={album.cover}
      spreads={spreads}
      current={current}
      onCurrentChange={setCurrent}
    />
  )
}
