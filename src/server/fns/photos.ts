import { createServerFn } from '@tanstack/react-start'
import { type } from 'arktype'
import { and, desc, eq, like } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { requireUser } from '@/server/auth'
import { db } from '@/server/db/client'
import { albums, photos, spreads } from '@/server/db/schema'
import { photoKeys, storage } from '@/server/storage'

export const list = createServerFn({ method: 'GET' }).handler(async () => {
  const ownerId = await requireUser()
  return db()
    .select()
    .from(photos)
    .where(eq(photos.ownerId, ownerId))
    .orderBy(desc(photos.createdAt))
})

/** Reserves a row and its R2 keys; the client then PUTs both files. */
export const create = createServerFn({ method: 'POST' })
  .validator(type({ width: 'number.integer > 0', height: 'number.integer > 0' }))
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    const id = nanoid(12)
    const row = {
      id,
      ownerId,
      ...photoKeys(ownerId, id),
      width: data.width,
      height: data.height,
      createdAt: Date.now(),
    }
    await db().insert(photos).values(row)
    return row
  })

export const remove = createServerFn({ method: 'POST' })
  .validator(type({ photoId: 'string' }))
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    const [photo] = await db()
      .select()
      .from(photos)
      .where(and(eq(photos.id, data.photoId), eq(photos.ownerId, ownerId)))
    if (!photo) throw new Response('Not found', { status: 404 })

    const [reference] = await db()
      .select({ id: spreads.id })
      .from(spreads)
      .innerJoin(albums, eq(albums.id, spreads.albumId))
      .where(
        and(
          eq(albums.ownerId, ownerId),
          like(spreads.elements, `%"photoId":"${photo.id}"%`),
        ),
      )
      .limit(1)
    if (reference) {
      // The client shows this verbatim, so it reads as a user-facing message.
      throw new Response('That photo is still on a page. Remove it there first.', {
        status: 409,
      })
    }

    await Promise.all([
      storage.delete(photo.key),
      storage.delete(photo.thumbKey),
    ])
    await db().delete(photos).where(eq(photos.id, photo.id))
    return { ok: true } as const
  })
