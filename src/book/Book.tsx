import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Element, PageSide } from '@/domain/element'
import { PAGE_UNITS, pageScale } from '@/domain/page'
import { Button } from '@/components/ui/button'
import type { Spread } from '@/server/db/schema'
import { PageSurface } from './PageSurface'
import { PhotoView } from './PhotoView'
import { TextView } from './TextView'

// phase 2: Leaf.tsx and useTurn.ts replace the flat two-page layout below with a
// 3D stack of leaves driven by a `progress` MotionValue. Cover.tsx wraps the
// stack. Nothing outside this module should need to change.

type BookProps = {
  spreads: Spread[]
  current: number
  onCurrentChange: (index: number) => void
  /** Editor slot. Falls back to read-only element rendering. */
  renderPage?: (spread: Spread, page: PageSide) => ReactNode
  /** Suppresses drag turning in edit mode. Arrows keep working. */
  locked?: boolean
}

export function Book({
  spreads,
  current,
  onCurrentChange,
  renderPage,
}: BookProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pagePx = usePagePx(containerRef)
  const spread = spreads[current]

  const go = (delta: number) => {
    const next = current + delta
    if (next < 0 || next >= spreads.length) return
    onCurrentChange(next)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') go(1)
      else if (event.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `go` closes over current/spreads, so rebind whenever either moves.
  }, [current, spreads.length])

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6">
      <div
        ref={containerRef}
        className="flex w-full max-w-5xl items-center justify-center"
      >
        <div className="flex shadow-[0_1px_2px_rgb(0_0_0/.08),0_8px_24px_rgb(0_0_0/.12),0_32px_64px_-16px_rgb(0_0_0/.28)]">
          {(['left', 'right'] as const).map((side) => (
            <PageSurface key={side} side={side} sizePx={pagePx}>
              {spread
                ? (renderPage?.(spread, side) ?? (
                    <Elements
                      elements={spread.elements.filter((el) => el.page === side)}
                      pagePx={pagePx}
                    />
                  ))
                : null}
            </PageSurface>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous spread"
          disabled={current <= 0}
          onClick={() => go(-1)}
        >
          <ChevronLeft />
        </Button>
        <span className="text-muted-foreground text-sm tabular-nums">
          {spreads.length === 0 ? '0 / 0' : `${current + 1} / ${spreads.length}`}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next spread"
          disabled={current >= spreads.length - 1}
          onClick={() => go(1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}

function Elements({
  elements,
  pagePx,
}: {
  elements: Element[]
  pagePx: number
}) {
  const scale = pageScale(pagePx)
  return (
    <>
      {elements.map((element) =>
        element.kind === 'photo' ? (
          <PhotoView key={element.id} element={element} scale={scale} />
        ) : (
          <TextView key={element.id} element={element} scale={scale} />
        ),
      )}
    </>
  )
}

/** Square page size: half the container, capped so the open book stays on screen. */
function usePagePx(ref: React.RefObject<HTMLDivElement | null>) {
  const [pagePx, setPagePx] = useState(PAGE_UNITS / 2)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const available = entry.contentRect.width / 2
      setPagePx(Math.max(120, Math.min(available, window.innerHeight * 0.7)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return Math.round(pagePx)
}
