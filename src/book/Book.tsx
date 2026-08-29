import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { motion, useTransform } from 'motion/react'
import type { Cover, Element, PageSide } from '@/domain/element'
import { pageScale } from '@/domain/page'
import { useMediaQuery } from '@/lib/use-media-query'
import type { Spread } from '@/server/db/schema'
import { CoverFace, Endpaper } from './Cover'
import { Leaf, type SpineAt } from './Leaf'
import { BOOK_SHADOW, PAPER } from './materials'
import { PageSurface } from './PageSurface'
import { PhotoView } from './PhotoView'
import { TextView } from './TextView'
import { useTurn, type TurnGeometry } from './useTurn'

/** How far the covers stick out past the page block, in px. */
const OVERHANG = 5
const PAD = 24
const MIN_PAGE = 120
/** Sheets rendered around the current position; the rest are edge stripes. */
const MOUNT_BEHIND = 3
const MOUNT_AHEAD = 2

type BookProps = {
  title: string
  cover: Cover
  spreads: Spread[]
  /** -1 = front cover, 0..n-1 = spreads, n = open at the back. */
  current: number
  onCurrentChange: (index: number) => void
  /** Editor slot; defaults to read-only element rendering. */
  renderPage?: (spread: Spread, page: PageSide, layout: PageLayout) => ReactNode
  /**
   * Rendered above the open spread in the book's own coordinate space, so the
   * editor can draw handles that reach past the paper. Desktop only.
   */
  overlay?: (layout: PageLayout) => ReactNode
  /** Disables drag and click turning. Arrow keys keep working. */
  locked?: boolean
}

/** Size of one rendered page and its page-unit multiplier. */
export type PageLayout = { pagePx: number; scale: number }

type SheetSpec = {
  front: ReactNode
  back: ReactNode
  cover?: boolean
}

/**
 * Desktop and tablet show a two-page spread hinged at the centre; phones show
 * one page at a time hinged at the left edge. Both are stacks of sheets driven
 * by the same turn engine, they only differ in how sheets map to spreads.
 */
export function Book({
  title,
  cover,
  spreads,
  current,
  onCurrentChange,
  renderPage,
  overlay,
  locked = false,
}: BookProps) {
  const phone = useMediaQuery('(max-width: 767px)')
  const rootRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(rootRef)
  const n = spreads.length

  const pagePx = Math.max(
    MIN_PAGE,
    Math.floor(
      phone
        ? Math.min(size.width - 2 * PAD, size.height - 2 * PAD - 2 * OVERHANG)
        : Math.min((size.width - 2 * PAD) / 2 - OVERHANG, size.height - 2 * PAD - 2 * OVERHANG),
    ),
  )
  const scale = pageScale(pagePx)

  // Mapping between the store's `current` and the engine's turned-sheet count.
  // Desktop: cover, then leaf j whose front is spread j-1's right page (leaf 0
  // carries the title page) and whose back is spread j's left page.
  // Phone: one sheet per face in reading order.
  const toTurned = phone
    ? (c: number) => (c < 0 ? 0 : Math.min(2 * c + 2, 2 * n + 2))
    : (c: number) => (c < 0 ? 0 : Math.min(c + 2, n + 2))
  const toCurrent = phone
    ? (t: number) => (t <= 1 ? -1 : t >= 2 * n + 2 ? n : Math.floor((t - 2) / 2))
    : (t: number) => (t <= 1 ? -1 : Math.min(t - 2, n))

  const [turned, setTurned] = useState(() => toTurned(current))
  useEffect(() => {
    if (toCurrent(turned) !== current) setTurned(toTurned(current))
  }, [current, phone])

  const handleTurned = (next: number) => {
    setTurned(next)
    const mapped = toCurrent(next)
    if (mapped !== current) onCurrentChange(mapped)
  }

  const page = (spread: Spread, side: PageSide) => (
    <PageSurface sizePx={pagePx} side={side}>
      {renderPage ? (
        renderPage(spread, side, { pagePx, scale })
      ) : (
        <PageElements elements={spread.elements} side={side} scale={scale} />
      )}
    </PageSurface>
  )
  const blank = (side: PageSide) => <PageSurface sizePx={pagePx} side={side} />
  const titlePage = (
    <PageSurface sizePx={pagePx} side="right">
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-[12%] text-center font-sans"
        style={{ color: 'oklch(0.42 0.012 70)', fontSize: pagePx * 0.04 }}
      >
        <span className="leading-snug font-medium tracking-[0.06em]">{title}</span>
        <span aria-hidden className="h-px w-[14%] bg-current opacity-40" />
      </div>
    </PageSurface>
  )

  const sheets: SheetSpec[] = phone
    ? [
        { front: <CoverFace cover={cover} title={title} side="front" />, back: <Endpaper cover={cover} side="left" />, cover: true },
        { front: titlePage, back: blank('left') },
        ...spreads.flatMap((spread) => [
          { front: page(spread, 'left'), back: blank('left') },
          { front: page(spread, 'right'), back: blank('left') },
        ]),
        { front: blank('right'), back: blank('left') },
      ]
    : [
        { front: <CoverFace cover={cover} title={title} side="front" />, back: <Endpaper cover={cover} side="left" />, cover: true },
        ...Array.from({ length: n + 1 }, (_, j) => ({
          front: j === 0 ? titlePage : page(spreads[j - 1], 'right'),
          back: j === n ? blank('left') : page(spreads[j], 'left'),
        })),
      ]

  return (
    <div ref={rootRef} className="relative flex size-full items-center justify-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_55%_at_50%_50%,--theme(--color-foreground/0.05),transparent)]"
      />
      {size.width > 0 ? (
        <BookStack
          key={phone ? 'phone' : 'desktop'}
          sheets={sheets}
          base={<Endpaper cover={cover} side="right" />}
          spineAt={phone ? 'left' : 'center'}
          pagePx={pagePx}
          turned={turned}
          onTurnedChange={handleTurned}
          endTurned={sheets.length}
          locked={locked}
          overlay={phone ? undefined : overlay?.({ pagePx, scale })}
        />
      ) : null}
    </div>
  )
}

type BookStackProps = {
  sheets: SheetSpec[]
  /** The inside of the back cover; never turns. */
  base: ReactNode
  spineAt: SpineAt
  pagePx: number
  turned: number
  onTurnedChange: (turned: number) => void
  /** Where the End key lands: every sheet turned, i.e. the inside back cover. */
  endTurned: number
  locked: boolean
  overlay?: ReactNode
}

function BookStack({
  sheets,
  base,
  spineAt,
  pagePx,
  turned,
  onTurnedChange,
  endTurned,
  locked,
  overlay,
}: BookStackProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const sheetCount = sheets.length
  const engine = useTurn({
    sheetCount,
    turned,
    onTurnedChange,
    locked,
    getGeometry: () => geometryOf(boxRef.current, spineAt),
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Locked means someone else drives the book; they own the keys too.
      if (locked) return
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return
      const handler = KEYS[event.key]
      if (!handler) return
      event.preventDefault()
      handler(engine, endTurned)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [engine, endTurned, locked])

  const boxWidth = spineAt === 'center' ? 2 * pagePx : pagePx
  const coverWidth = pagePx + OVERHANG
  const coverHeight = pagePx + 2 * OVERHANG
  // A closed book is centred on its cover; opening it slides the spine to the middle.
  const shift = useTransform(
    engine.progressFor(0),
    [0, 1],
    [spineAt === 'center' ? -(pagePx + OVERHANG) / 2 : 0, 0],
  )

  const turnedLeaves = sheets.filter((sheet, i) => !sheet.cover && i < turned).length
  const restingLeaves = sheets.filter((sheet, i) => !sheet.cover && i >= turned).length

  return (
    <div style={{ perspective: Math.max(1800, pagePx * 3.5) }}>
      <motion.div
        ref={boxRef}
        className="relative"
        style={{ width: boxWidth, height: pagePx, x: shift }}
      >
        {spineAt === 'center' && turnedLeaves > 0 ? (
          <EdgeStripes side="left" count={turnedLeaves} pagePx={pagePx} />
        ) : null}
        {turned > 0 && restingLeaves > 0 ? (
          <EdgeStripes side="right" count={restingLeaves} pagePx={pagePx} />
        ) : null}

        <div
          className="absolute"
          style={{
            top: -OVERHANG,
            left: spineAt === 'center' ? '50%' : 0,
            width: coverWidth,
            height: coverHeight,
            boxShadow: BOOK_SHADOW,
            zIndex: 0,
          }}
        >
          {base}
        </div>

        {sheets.map((sheet, s) => {
          const mounted = s === 0 || (s >= turned - MOUNT_BEHIND && s <= turned + MOUNT_AHEAD)
          if (!mounted) return null
          const grabbable = !locked && (s === turned || s === turned - 1)
          return (
            <Leaf
              key={s}
              sheet={s}
              sheetCount={sheetCount}
              progress={engine.progressFor(s)}
              spineAt={spineAt}
              width={sheet.cover ? coverWidth : pagePx}
              height={sheet.cover ? coverHeight : pagePx}
              top={sheet.cover ? -OVERHANG : 0}
              front={sheet.front}
              back={sheet.back}
              reduced={engine.reduced}
              shadow={sheet.cover ? BOOK_SHADOW : undefined}
              grabbable={grabbable}
              onPointerDown={(event) => engine.onPointerDown(s, event)}
            />
          )
        })}

        {overlay ? (
          <div className="absolute inset-0" style={{ zIndex: 3 * sheetCount }}>
            {overlay}
          </div>
        ) : null}
      </motion.div>
    </div>
  )
}

const KEYS: Record<string, (engine: ReturnType<typeof useTurn>, end: number) => void> = {
  ArrowRight: (engine) => engine.next(),
  ArrowLeft: (engine) => engine.prev(),
  Home: (engine) => engine.goTo(0),
  End: (engine, end) => engine.goTo(end),
}

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
  )
}

function geometryOf(box: HTMLElement | null, spineAt: SpineAt): TurnGeometry | null {
  if (!box) return null
  const rect = box.getBoundingClientRect()
  return spineAt === 'center'
    ? { spineX: rect.left + rect.width / 2, pageWidth: rect.width / 2, top: rect.top, height: rect.height }
    : { spineX: rect.left, pageWidth: rect.width, top: rect.top, height: rect.height }
}

/** The visible thickness of a stack of pages, drawn as offset hairlines. */
function EdgeStripes({ side, count, pagePx }: { side: 'left' | 'right'; count: number; pagePx: number }) {
  const direction = side === 'left' ? -1 : 1
  const lines = Array.from({ length: Math.min(count, 7) }, (_, i) => {
    const k = i + 1
    const color = k % 2 === 0 ? PAPER : 'rgb(0 0 0 / .12)'
    return `${direction * k}px ${Math.ceil(k * 0.6)}px 0 ${color}`
  })
  return (
    <div
      aria-hidden
      className="absolute top-0"
      style={{
        [side]: 0,
        width: pagePx,
        height: pagePx,
        backgroundColor: PAPER,
        boxShadow: lines.join(','),
        zIndex: 0,
      }}
    />
  )
}

/** Read-only element rendering; the editor swaps in its own via `renderPage`. */
export function PageElements({ elements, side, scale }: { elements: Element[]; side: PageSide; scale: number }) {
  return (
    <>
      {elements
        .filter((element) => element.page === side)
        .map((element) =>
          element.kind === 'photo' ? (
            <PhotoView key={element.id} element={element} scale={scale} />
          ) : (
            <TextView key={element.id} element={element} scale={scale} />
          ),
        )}
    </>
  )
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}
