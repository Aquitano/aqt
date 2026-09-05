import { and, desc, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/server/db/client'
import { photos, spreadPhotos, type Photo } from '@/server/db/schema'
import { photoKeys, storage } from '@/server/storage'

export function listPhotos(ownerId: string) {
  return db()
    .select()
    .from(photos)
    .where(eq(photos.ownerId, ownerId))
    .orderBy(desc(photos.createdAt))
}

/** Reserves a row and its R2 keys; the caller then PUTs both files. */
export async function createPhoto(
  ownerId: string,
  data: { width: number; height: number; takenAt?: number },
) {
  const id = nanoid(12)
  const row: Photo = {
    id,
    ownerId,
    ...photoKeys(ownerId, id),
    width: data.width,
    height: data.height,
    takenAt: data.takenAt ?? null,
    createdAt: Date.now(),
  }
  await db().insert(photos).values(row)
  return row
}

/** 400 unless every id names a photo of this owner. */
export async function assertOwnsPhotos(ownerId: string, photoIds: string[]) {
  if (photoIds.length === 0) return
  const rows = await db()
    .select({ id: photos.id })
    .from(photos)
    .where(and(eq(photos.ownerId, ownerId), inArray(photos.id, photoIds)))
  const known = new Set(rows.map((r) => r.id))
  const unknown = photoIds.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new Response(`Unknown photo: ${unknown.join(', ')}`, { status: 400 })
  }
}

export async function deletePhoto(photoId: string, ownerId: string) {
  const [photo] = await db()
    .select()
    .from(photos)
    .where(and(eq(photos.id, photoId), eq(photos.ownerId, ownerId)))
  if (!photo) throw new Response('Not found', { status: 404 })

  const [reference] = await db()
    .select({ spreadId: spreadPhotos.spreadId })
    .from(spreadPhotos)
    .where(eq(spreadPhotos.photoId, photo.id))
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
