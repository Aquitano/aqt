import { type } from 'arktype'
import { cover, elementList } from './element'

/**
 * Request bodies of the JSON API (`/api/v1`). Shared with the CLI so both ends
 * validate against the same definitions.
 */

const MAX_SPREADS = 200

export const albumInput = type({ title: 'string > 0', cover })

export const albumPatch = type({ 'title?': 'string > 0', 'cover?': cover })

export const spreadInput = type({
  /** Keep ids on a get -> edit -> put round trip; omitted ids are minted. */
  'id?': 'string > 0',
  elements: elementList,
})

/** The whole book in one payload: cover fields plus every spread in order. */
export const bookInput = type({
  'title?': 'string > 0',
  'cover?': cover,
  spreads: spreadInput.array().atMostLength(MAX_SPREADS),
})

export const photoInput = type({
  width: 'number.integer > 0',
  height: 'number.integer > 0',
  'takenAt?': 'number.integer',
})

export type AlbumInput = typeof albumInput.infer
export type AlbumPatch = typeof albumPatch.infer
export type SpreadInput = typeof spreadInput.infer
export type BookInput = typeof bookInput.infer
export type PhotoInput = typeof photoInput.infer
