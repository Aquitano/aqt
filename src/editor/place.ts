import { nanoid } from 'nanoid'
import type { Element, PageSide, PhotoElement, TextElement } from '@/domain/element'
import { PAGE_UNITS } from '@/domain/page'
import type { Photo } from '@/server/db/schema'

/** What the library hands over when a photo is dragged onto a page. */
export type PhotoRef = Pick<Photo, 'id' | 'width' | 'height'>
import type { Point } from './geometry'

/** Caption colours: ink first, then a few that sit well on cream paper. */
export const CAPTION_COLORS = [
  'oklch(0.28 0.01 60)',
  'oklch(0.55 0.015 70)',
  'oklch(0.42 0.11 22)',
  'oklch(0.45 0.07 152)',
  'oklch(0.40 0.08 258)',
  'oklch(0.62 0.12 60)',
] as const


/** Page for a new element: the selection's page, otherwise the emptier one. */
export function targetPage(elements: Element[], selection: string | null): PageSide {
  const selected = elements.find((el) => el.id === selection)
  if (selected) return selected.page
  const left = elements.filter((el) => el.page === 'left').length
  const right = elements.filter((el) => el.page === 'right').length
  return right < left ? 'right' : 'left'
}

/** A photo at 40% page width, centred on `at` or on the page. */
export function photoElementFor(photo: PhotoRef, page: PageSide, at?: Point): PhotoElement {
  const w = PAGE_UNITS * 0.4
  const h = (w * photo.height) / photo.width
  const c = at ?? { x: PAGE_UNITS / 2, y: PAGE_UNITS / 2 }
  return {
    id: nanoid(10),
    kind: 'photo',
    page,
    photoId: photo.id,
    frame: 'none',
    x: c.x - w / 2,
    y: c.y - h / 2,
    w,
    h,
    rotation: 0,
  }
}

export function textElementFor(page: PageSide): TextElement {
  return {
    id: nanoid(10),
    kind: 'text',
    page,
    text: 'A caption',
    font: 'hand',
    size: 48,
    color: CAPTION_COLORS[0],
    align: 'center',
    x: PAGE_UNITS * 0.25,
    y: PAGE_UNITS * 0.46,
    w: PAGE_UNITS * 0.5,
    h: 60,
    rotation: 0,
  }
}
