import { createServerFn } from '@tanstack/react-start'
import { type } from 'arktype'
import { and, asc, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { cover } from '@/domain/element'
import { requireUser } from '@/server/auth'
import { db } from '@/server/db/client'
import { albums, spreads } from '@/server/db/schema'

const createInput = type({
  title: 'string > 0',
  cover,
})

const updateInput = type({
  albumId: 'string',
  'title?': 'string > 0',
  'cover?': cover,
})

const albumIdInput = type({ albumId: 'string' })

/** The album, or undefined when it is missing or owned by someone else. */
async function findOwnedAlbum(albumId: string, ownerId: string) {
  const [album] = await db()
    .select()
    .from(albums)
    .where(and(eq(albums.id, albumId), eq(albums.ownerId, ownerId)))
  return album
}

/** Throws 404 when the album is missing or owned by someone else. */
async function ownedAlbum(albumId: string, ownerId: string) {
  const album = await findOwnedAlbum(albumId, ownerId)
  if (!album) throw new Response('Not found', { status: 404 })
  return album
}

export const list = createServerFn({ method: 'GET' }).handler(async () => {
  const ownerId = await requireUser()
  return db()
    .select()
    .from(albums)
    .where(eq(albums.ownerId, ownerId))
    .orderBy(desc(albums.updatedAt))
})

/** Null rather than a throw, so the route can render its not-found page. */
export const get = createServerFn({ method: 'GET' })
  .validator(albumIdInput)
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    const album = await findOwnedAlbum(data.albumId, ownerId)
    if (!album) return null
    const pages = await db()
      .select()
      .from(spreads)
      .where(eq(spreads.albumId, album.id))
      .orderBy(asc(spreads.position))
    return { album, spreads: pages }
  })

/** Public read model for `/s/$slug`. No auth. Null when the link is unknown. */
export const getShared = createServerFn({ method: 'GET' })
  .validator(type({ slug: 'string' }))
  .handler(async ({ data }) => {
    const [album] = await db()
      .select()
      .from(albums)
      .where(eq(albums.shareSlug, data.slug))
    if (!album) return null
    const pages = await db()
      .select()
      .from(spreads)
      .where(eq(spreads.albumId, album.id))
      .orderBy(asc(spreads.position))
    return { album, spreads: pages }
  })

export const create = createServerFn({ method: 'POST' })
  .validator(createInput)
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    const now = Date.now()
    const album = {
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
      db()
        .insert(spreads)
        .values({
          id: nanoid(12),
          albumId: album.id,
          position: 0,
          elements: [],
          updatedAt: now,
        }),
    ])
    return album
  })

export const update = createServerFn({ method: 'POST' })
  .validator(updateInput)
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    await ownedAlbum(data.albumId, ownerId)
    await db()
      .update(albums)
      .set({
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.cover === undefined ? {} : { cover: data.cover }),
        updatedAt: Date.now(),
      })
      .where(eq(albums.id, data.albumId))
    return { ok: true } as const
  })

export const remove = createServerFn({ method: 'POST' })
  .validator(albumIdInput)
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    await ownedAlbum(data.albumId, ownerId)
    // Explicit, so the delete does not depend on D1 having FK enforcement on.
    await db().batch([
      db().delete(spreads).where(eq(spreads.albumId, data.albumId)),
      db().delete(albums).where(eq(albums.id, data.albumId)),
    ])
    return { ok: true } as const
  })
