import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Element } from '@/domain/element'
import { ownedAlbum } from '@/server/albums'
import { db } from '@/server/db/client'
import { albums, spreads, type Spread } from '@/server/db/schema'

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

export async function insertSpread(
  ownerId: string,
  data: { albumId: string; afterPosition: number; id?: string; elements?: Element[] },
) {
  await ownedAlbum(data.albumId, ownerId)
  const at = data.afterPosition + 1
  const spread: Spread = {
    id: data.id ?? nanoid(12),
    albumId: data.albumId,
    position: at,
    elements: data.elements ?? [],
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
}

export async function deleteSpread(spreadId: string, ownerId: string) {
  const spread = await ownedSpread(spreadId, ownerId)
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
}

export async function reorderSpreads(albumId: string, ownerId: string, orderedIds: string[]) {
  await ownedAlbum(albumId, ownerId)
  const owned = await db()
    .select({ id: spreads.id })
    .from(spreads)
    .where(eq(spreads.albumId, albumId))
  const ownedIds = new Set(owned.map((s) => s.id))
  if (orderedIds.length !== ownedIds.size || orderedIds.some((id) => !ownedIds.has(id))) {
    throw new Response('orderedIds must list every spread of the album', { status: 400 })
  }
  await setPositions(albumId, orderedIds)
}

/** Autosave target. */
export async function saveElements(spreadId: string, ownerId: string, elements: Element[]) {
  await ownedSpread(spreadId, ownerId)
  const updatedAt = Date.now()
  await db().update(spreads).set({ elements, updatedAt }).where(eq(spreads.id, spreadId))
  return updatedAt
}
