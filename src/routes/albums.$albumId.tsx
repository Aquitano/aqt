import { useEffect, useMemo } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AlbumHeader } from '@/editor/AlbumHeader'
import { attachAutosave } from '@/editor/autosave'
import { Editor } from '@/editor/Editor'
import { EditorStoreProvider, createEditorStore } from '@/editor/store'
import { requireSignedIn } from '@/lib/guard'
import { albumQuery } from '@/lib/queries'
import { useMediaQuery } from '@/lib/use-media-query'

export const Route = createFileRoute('/albums/$albumId')({
  beforeLoad: requireSignedIn,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(albumQuery(params.albumId)),
  component: AlbumPage,
})

function AlbumPage() {
  const { albumId } = Route.useParams()
  const { data } = useSuspenseQuery(albumQuery(albumId))
  const phone = useMediaQuery('(max-width: 767px)')

  // One store per open album; recreated when the album identity changes.
  const store = useMemo(
    () => createEditorStore(data.album, data.spreads),
    [data.album.id],
  )

  useEffect(() => attachAutosave(store), [store])

  return (
    <EditorStoreProvider value={store}>
      <TooltipProvider>
        <main className="relative flex h-dvh flex-col">
          <AlbumHeader canEdit={!phone} />
          <Editor canEdit={!phone} />
        </main>
      </TooltipProvider>
    </EditorStoreProvider>
  )
}
