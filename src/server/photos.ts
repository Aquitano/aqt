import { and, desc, eq, like } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/server/db/client'
import { albums, photos, spreads, type Photo } from '@/server/db/schema'
import { photoKeys, storage } from '@/server/storage'

export function listPhotos(ownerId: string) {
  return db()
    .select()
    .from(photos)
    .where(eq(photos.ownerId, ownerId))
    .orderBy(desc(photos.createdAt))
}

/** Reserves a row and its R2 keys; the caller then PUTs both files. */
export async function createPhoto(ownerId: string, data: { width: number; height: number }) {
  const id = nanoid(12)
  const row: Photo = {
    id,
    ownerId,
    ...photoKeys(ownerId, id),
    width: data.width,
    height: data.height,
    createdAt: Date.now(),
  }
  await db().insert(photos).values(row)
  return row
}

export async function deletePhoto(photoId: string, ownerId: string) {
  const [photo] = await db()
    .select()
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId)))
  if (!photo) throw new Response('Not found', { status: 404 })

  const [reference] = await db()
    .select({ id: spreads.id })
    .from(spreads)
    .innerJoin(albums, eq(albums.id, spreads.albumId))
    .where(
      and(eq(albums.ownerId, ownerId), like(spreads.elements, `%"photoId":"${photo.id}"%`)),
    )
    .limit(1)
  if (reference) {
    // The client shows this verbatim, so it reads as a user-facing message.
    throw new Response('That photo is still on a page. Remove it there first.', {
      status: 409,
    })
  }

  await Promise.all([storage.delete(photo.key), storage.delete(photo.thumbKey)])
  await db().delete(photos).where(eq(photos.id, photo.id))
}
