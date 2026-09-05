import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Cover } from '@/domain/element'
import { db } from '@/server/db/client'
import { albums, spreadPhotos, spreads, type Album } from '@/server/db/schema'

/**
 * Album operations, independent of transport. Server functions and the JSON
 * API both call these; every one takes the caller's user id explicitly and
 * throws a `Response` on failure, which either layer can send as is.
 */

/** The album, or undefined when it is missing or owned by someone else. */
export async function findOwnedAlbum(albumId: string, ownerId: string) {
  const [album] = await db()
    .select()
    .from(albums)
    .where(and(eq(albums.id, albumId), eq(albums.ownerId, ownerId)))
  return album
}

/** Throws 404 when the album is missing or owned by someone else. */
export async function ownedAlbum(albumId: string, ownerId: string) {
  const album = await findOwnedAlbum(albumId, ownerId)
  if (!album) throw new Response('Not found', { status: 404 })
  return album
}

/** Spreads of an album in reading order. */
export function spreadsOf(albumId: string) {
  return db()
    .select()
    .from(spreads)
    .where(eq(spreads.albumId, albumId))
    .orderBy(asc(spreads.position))
}

async function withSpreads(album: Album) {
  return { album, spreads: await spreadsOf(album.id) }
}

export function listAlbums(ownerId: string) {
  return db()
    .select()
    .from(albums)
    .where(eq(albums.ownerId, ownerId))
    .orderBy(desc(albums.updatedAt))
}

/** Null rather than a throw, so routes can render their not-found page. */
export async function getAlbum(albumId: string, ownerId: string) {
  const album = await findOwnedAlbum(albumId, ownerId)
  return album ? withSpreads(album) : null
}

/** Public read model for `/s/$slug`. Null when the link is unknown. */
export async function getSharedAlbum(slug: string) {
  const [album] = await db().select().from(albums).where(eq(albums.shareSlug, slug))
  return album ? withSpreads(album) : null
}

export async function createAlbum(ownerId: string, data: { title: string; cover: Cover }) {
  const now = Date.now()
  const album: Album = {
    id: nanoid(12),
    ownerId,
    title: data.title,
    cover: data.cover,
    shareSlug: null,
    createdAt: now,
    updatedAt: now,
  }
  // A new album opens on an empty spread so the book is never a void.
  await db().batch([
    db().insert(albums).values(album),
    db().insert(spreads).values({
      id: nanoid(12),
      albumId: album.id,
      position: 0,
      elements: [],
      updatedAt: now,
    }),
  ])
  return album
}

export async function updateAlbum(
  albumId: string,
  ownerId: string,
  patch: { title?: string; cover?: Cover },
) {
  await ownedAlbum(albumId, ownerId)
  await db()
    .update(albums)
    .set({
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.cover === undefined ? {} : { cover: patch.cover }),
      updatedAt: Date.now(),
    })
    .where(eq(albums.id, albumId))
}

export async function deleteAlbum(albumId: string, ownerId: string) {
  await ownedAlbum(albumId, ownerId)
  // Explicit, so the delete does not depend on D1 having FK enforcement on.
  const albumSpreads = db().select({ id: spreads.id }).from(spreads).where(eq(spreads.albumId, albumId))
  await db().batch([
    db().delete(spreadPhotos).where(inArray(spreadPhotos.spreadId, albumSpreads)),
    db().delete(spreads).where(eq(spreads.albumId, albumId)),
    db().delete(albums).where(eq(albums.id, albumId)),
  ])
}

/** Idempotent: an album that is already shared keeps its slug. */
export async function enableShare(albumId: string, ownerId: string) {
  const album = await ownedAlbum(albumId, ownerId)
  if (album.shareSlug) return album.shareSlug
  const slug = nanoid(10)
  await db()
    .update(albums)
    .set({ shareSlug: slug, updatedAt: Date.now() })
    .where(eq(albums.id, album.id))
  return slug
}

export async function disableShare(albumId: string, ownerId: string) {
  await ownedAlbum(albumId, ownerId)
  await db()
    .update(albums)
    .set({ shareSlug: null, updatedAt: Date.now() })
    .where(eq(albums.id, albumId))
}
