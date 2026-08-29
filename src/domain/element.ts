import { type } from 'arktype'

/**
 * Element geometry lives in page units (see PAGE_UNITS) so layouts are
 * resolution independent. These schemas are the single source of truth for
 * both the `spreads.elements` JSON column and the wire format of server fns.
 */

export const pageSide = type("'left' | 'right'")

export const photoFrame = type("'none' | 'polaroid' | 'corners' | 'tape'")

const elementBase = {
  id: 'string',
  page: pageSide,
  x: 'number',
  y: 'number',
  w: 'number',
  h: 'number',
  rotation: 'number',
} as const

export const photoElement = type({
  ...elementBase,
  kind: "'photo'",
  photoId: 'string',
  frame: photoFrame,
})

export const textElement = type({
  ...elementBase,
  kind: "'text'",
  text: 'string',
  font: "'hand' | 'clean'",
  size: 'number',
  color: 'string',
  align: "'left' | 'center' | 'right'",
})

export const element = photoElement.or(textElement)

export const elementList = element.array()

export const coverMaterial = type("'linen' | 'leather' | 'cloth'")

export const cover = type({
  material: coverMaterial,
  color: 'string',
})

export type PageSide = typeof pageSide.infer
export type PhotoFrame = typeof photoFrame.infer
export type PhotoElement = typeof photoElement.infer
export type TextElement = typeof textElement.infer
export type Element = typeof element.infer
export type CoverMaterial = typeof coverMaterial.infer
export type Cover = typeof cover.infer
