import { type } from 'arktype'
import { PAGE_UNITS } from './page'

/**
 * Element geometry lives in page units (see PAGE_UNITS) so layouts are
 * resolution independent. These schemas are the single source of truth for
 * both the `spreads.elements` JSON column and the wire format of server fns
 * and the JSON API, so the bounds below are what every client is held to.
 */

export const pageSide = type("'left' | 'right'")

export const photoFrame = type("'none' | 'polaroid' | 'corners' | 'tape'")

/** Smallest box the editor lets you resize to. */
export const MIN_ELEMENT_SIZE = 40
/** Boxes may bleed past the page, but never absurdly so. */
const MAX_ELEMENT_SIZE = 4 * PAGE_UNITS
const MAX_OFFSET = 4 * PAGE_UNITS

export const MIN_TEXT_SIZE = 20
export const MAX_TEXT_SIZE = 200
const MAX_TEXT_LENGTH = 2000

const elementBase = {
  id: 'string > 0',
  page: pageSide,
  x: `${-MAX_OFFSET} <= number <= ${MAX_OFFSET}`,
  y: `${-MAX_OFFSET} <= number <= ${MAX_OFFSET}`,
  w: `${MIN_ELEMENT_SIZE} <= number <= ${MAX_ELEMENT_SIZE}`,
  h: `0 < number <= ${MAX_ELEMENT_SIZE}`,
  rotation: '-360 <= number <= 360',
} as const

/**
 * The unrotated box must overlap its page, otherwise the element is invisible
 * and unreachable. The editor enforces a stricter "10% on page" rule when
 * moving; this is the floor for everyone else.
 */
function overlapsPage(box: { x: number; y: number; w: number; h: number }) {
  return box.x < PAGE_UNITS && box.x + box.w > 0 && box.y < PAGE_UNITS && box.y + box.h > 0
}

export const photoElement = type({
  ...elementBase,
  kind: "'photo'",
  photoId: 'string > 0',
  frame: photoFrame,
}).narrow((el, ctx) => overlapsPage(el) || ctx.mustBe('on the page'))

export const textElement = type({
  ...elementBase,
  kind: "'text'",
  text: `string <= ${MAX_TEXT_LENGTH}`,
  font: "'hand' | 'clean'",
  size: `${MIN_TEXT_SIZE} <= number <= ${MAX_TEXT_SIZE}`,
  color: 'string > 0',
  align: "'left' | 'center' | 'right'",
}).narrow((el, ctx) => overlapsPage(el) || ctx.mustBe('on the page'))

export const element = photoElement.or(textElement)

export const elementList = element.array()

export const coverMaterial = type("'linen' | 'leather' | 'cloth'")

export const cover = type({
  material: coverMaterial,
  color: 'string > 0',
})

export type PageSide = typeof pageSide.infer
export type PhotoFrame = typeof photoFrame.infer
export type PhotoElement = typeof photoElement.infer
export type TextElement = typeof textElement.infer
export type Element = typeof element.infer
export type CoverMaterial = typeof coverMaterial.infer
export type Cover = typeof cover.infer
