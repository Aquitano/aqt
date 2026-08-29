import { createServerFn } from '@tanstack/react-start'
import { type } from 'arktype'
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { elementList } from '@/domain/element'
import { requireUser } from '@/server/auth'
import { db } from '@/server/db/client'
import { albums, spreads } from '@/server/db/schema'

/** Throws 404 when the album is missing or owned by someone else. */
async function assertAlbumOwner(albumId: string, ownerId: string) {
  const [album] = await db()
    .select({ id: albums.id })
    .from(albums)
    .where(and(eq(albums.id, albumId), eq(albums.ownerId, ownerId)))
  if (!album) throw new Response('Not found', { status: 404 })
}

/** Resolves a spread to its album after checking ownership. */
async function ownedSpread(spreadId: string, ownerId: string) {
  const [row] = await db()
    .select({ id: spreads.id, albumId: spreads.albumId })
    .from(spreads)
    .innerJoin(albums, eq(albums.id, spreads.albumId))
    .where(and(eq(spreads.id, spreadId), eq(albums.ownerId, ownerId)))
  if (!row) throw new Response('Not found', { status: 404 })
  return row
}

/** Rewrites every position for an album in a single UPDATE ... CASE statement. */
async function setPositions(albumId: string, orderedIds: string[]) {
  if (orderedIds.length === 0) return
  const branches = sql.join(
    orderedIds.map((id, position) => sql`when ${id} then ${position}`),
    sql` `,
  )
  await db()
    .update(spreads)
    .set({ position: sql`case ${spreads.id} ${branches} end` })
    .where(eq(spreads.albumId, albumId))
}

export const insert = createServerFn({ method: 'POST' })
  .validator(
    // The editor creates the id up front so its optimistic state matches the row.
    type({ albumId: 'string', afterPosition: 'number.integer', 'id?': 'string' }),
  )
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    await assertAlbumOwner(data.albumId, ownerId)
    const at = data.afterPosition + 1
    const spread = {
      id: data.id ?? nanoid(12),
      albumId: data.albumId,
      position: at,
      elements: [],
      updatedAt: Date.now(),
    }
    await db().batch([
      db()
        .update(spreads)
        .set({ position: sql`${spreads.position} + 1` })
        .where(and(eq(spreads.albumId, data.albumId), gte(spreads.position, at))),
      db().insert(spreads).values(spread),
    ])
    return spread
  })

export const remove = createServerFn({ method: 'POST' })
  .validator(type({ spreadId: 'string' }))
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    const spread = await ownedSpread(data.spreadId, ownerId)
    await db().delete(spreads).where(eq(spreads.id, spread.id))
    const rest = await db()
      .select({ id: spreads.id })
      .from(spreads)
      .where(eq(spreads.albumId, spread.albumId))
      .orderBy(asc(spreads.position))
    await setPositions(
      spread.albumId,
      rest.map((r) => r.id),
    )
    return { ok: true } as const
  })

export const reorder = createServerFn({ method: 'POST' })
  .validator(type({ albumId: 'string', orderedIds: 'string[]' }))
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    await assertAlbumOwner(data.albumId, ownerId)
    const owned = await db()
      .select({ id: spreads.id })
      .from(spreads)
      .where(eq(spreads.albumId, data.albumId))
    const ownedIds = new Set(owned.map((s) => s.id))
    if (
      data.orderedIds.length !== ownedIds.size ||
      data.orderedIds.some((id) => !ownedIds.has(id))
    ) {
      throw new Response('orderedIds must list every spread of the album', {
        status: 400,
      })
    }
    await setPositions(data.albumId, data.orderedIds)
    return { ok: true } as const
  })

/** Autosave target. */
export const saveElements = createServerFn({ method: 'POST' })
  .validator(type({ spreadId: 'string', elements: elementList }))
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    await ownedSpread(data.spreadId, ownerId)
    const updatedAt = Date.now()
    await db()
      .update(spreads)
      .set({ elements: data.elements, updatedAt })
      .where(eq(spreads.id, data.spreadId))
    return { updatedAt }
  })
