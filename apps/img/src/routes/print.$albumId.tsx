import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { PageElements } from '@/book/Book'
import { CoverFace } from '@/book/Cover'
import { PageSurface } from '@/book/PageSurface'
import { PAGE_UNITS } from '@/domain/page'
import { requireSignedIn } from '@/lib/guard'
import { albumQuery } from '@/lib/queries'

/**
 * Print layout: the cover on a square page, then one landscape page per
 * spread, all at 1 CSS px per page unit. `album export` prints this to PDF.
 */
export const Route = createFileRoute('/print/$albumId')({
  beforeLoad: requireSignedIn,
  loader: async ({ context, params }) => {
    const album = await context.queryClient.ensureQueryData(albumQuery(params.albumId))
    if (!album) throw notFound()
  },
  notFoundComponent: () => <p className="p-6">This album is not available.</p>,
  component: PrintRoute,
})

const PRINT_CSS = `
  @page { size: ${2 * PAGE_UNITS}px ${PAGE_UNITS}px; margin: 0; }
  @page cover { size: ${PAGE_UNITS}px ${PAGE_UNITS}px; }
  [data-print-page] { break-after: page; }
  [data-print-page="cover"] { page: cover; }
  @media print { body { background: white; } }
`

function PrintRoute() {
  const { albumId } = Route.useParams()
  const { data } = useSuspenseQuery(albumQuery(albumId))
  if (!data) return null
  const { album, spreads } = data

  return (
    <main data-print-root className="flex flex-col items-start">
      <style>{PRINT_CSS}</style>
      <div data-print-page="cover" style={{ width: PAGE_UNITS, height: PAGE_UNITS }}>
        <CoverFace cover={album.cover} title={album.title} side="front" style={{ borderRadius: 0 }} />
      </div>
      {spreads.map((spread) => (
        <div key={spread.id} data-print-page="spread" className="flex">
          <PageSurface sizePx={PAGE_UNITS} side="left" style={{ borderRadius: 0 }}>
            <PageElements elements={spread.elements} side="left" scale={1} />
          </PageSurface>
          <PageSurface sizePx={PAGE_UNITS} side="right" style={{ borderRadius: 0 }}>
            <PageElements elements={spread.elements} side="right" scale={1} />
          </PageSurface>
        </div>
      ))}
    </main>
  )
}
