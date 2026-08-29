import { PAGE_UNITS } from '@/domain/page'

export type Point = { x: number; y: number }

/** Unrotated top-left box plus rotation about its centre, all in page units. */
export type Box = { x: number; y: number; w: number; h: number; rotation: number }

/** Which corner handle is being dragged: -1 = left/top, 1 = right/bottom. */
export type Corner = { sx: -1 | 1; sy: -1 | 1 }

export type Guide = { axis: 'x' | 'y'; at: number }

export const CORNERS: readonly Corner[] = [
  { sx: -1, sy: -1 },
  { sx: 1, sy: -1 },
  { sx: 1, sy: 1 },
  { sx: -1, sy: 1 },
]

const MIN_SIZE = 40
const LINES = [0, PAGE_UNITS / 2, PAGE_UNITS]
/** Fraction of a box that must stay on the page so it can always be grabbed. */
const MIN_ON_PAGE = 0.1

export function centerOf(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

function rotate(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/**
 * Resize by dragging one corner while the opposite corner stays put. The
 * pointer is mapped into the box's own rotated frame, so the maths is the same
 * at any angle. Aspect-locked resizing projects the pointer onto the box
 * diagonal, so dragging inward shrinks and outward grows.
 */
export function resizeFromCorner(
  box: Box,
  corner: Corner,
  pointer: Point,
  mode: 'aspect' | 'width',
): Box {
  const c = centerOf(box)
  const anchor = add(c, rotate({ x: (-corner.sx * box.w) / 2, y: (-corner.sy * box.h) / 2 }, box.rotation))
  const local = rotate(sub(pointer, anchor), -box.rotation)

  let w = Math.max(MIN_SIZE, local.x * corner.sx)
  let h = box.h
  if (mode === 'aspect') {
    const dx = corner.sx * box.w
    const dy = corner.sy * box.h
    const along = (local.x * dx + local.y * dy) / (dx * dx + dy * dy)
    const factor = Math.max(along, MIN_SIZE / box.w, MIN_SIZE / box.h)
    w = box.w * factor
    h = box.h * factor
  }

  const next = add(anchor, rotate({ x: (corner.sx * w) / 2, y: (corner.sy * h) / 2 }, box.rotation))
  return { ...box, w, h, x: next.x - w / 2, y: next.y - h / 2 }
}

/** Angle of a pointer around the box centre, in degrees. */
export function angleAround(box: Box, pointer: Point) {
  const c = centerOf(box)
  return (Math.atan2(pointer.y - c.y, pointer.x - c.x) * 180) / Math.PI
}

export function snapAngle(deg: number, step = 15) {
  return Math.round(deg / step) * step
}

export function normalizeAngle(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180
}

/** Snaps a moved box's edges and centre to the page centre lines and edges. */
export function snapMove(box: Box, threshold: number): { box: Box; guides: Guide[] } {
  const guides: Guide[] = []
  const x = snapAxis([box.x, box.x + box.w / 2, box.x + box.w], threshold)
  const y = snapAxis([box.y, box.y + box.h / 2, box.y + box.h], threshold)
  if (x) guides.push({ axis: 'x', at: x.line })
  if (y) guides.push({ axis: 'y', at: y.line })
  return {
    box: { ...box, x: box.x + (x?.delta ?? 0), y: box.y + (y?.delta ?? 0) },
    guides,
  }
}

function snapAxis(edges: number[], threshold: number) {
  let best: { delta: number; line: number } | null = null
  for (const edge of edges) {
    for (const line of LINES) {
      const delta = line - edge
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, line }
      }
    }
  }
  return best
}

/** Keeps at least MIN_ON_PAGE of the box inside the page, so it stays reachable. */
export function clampToPage(box: Box): Box {
  return {
    ...box,
    x: clamp(box.x, -box.w * (1 - MIN_ON_PAGE), PAGE_UNITS - box.w * MIN_ON_PAGE),
    y: clamp(box.y, -box.h * (1 - MIN_ON_PAGE), PAGE_UNITS - box.h * MIN_ON_PAGE),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function axisLock(delta: Point): Point {
  return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y }
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}
