import { createServerFn } from '@tanstack/react-start'
import { type } from 'arktype'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { requireUser } from '@/server/auth'
import { db } from '@/server/db/client'
import { albums } from '@/server/db/schema'

const albumIdInput = type({ albumId: 'string' })

async function ownedAlbum(albumId: string, ownerId: string) {
  const [album] = await db()
    .select()
    .from(albums)
    .where(and(eq(albums.id, albumId), eq(albums.ownerId, ownerId)))
  if (!album) throw new Response('Not found', { status: 404 })
  return album
}

/** Idempotent: an album that is already shared keeps its slug. */
export const enable = createServerFn({ method: 'POST' })
  .validator(albumIdInput)
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    const album = await ownedAlbum(data.albumId, ownerId)
    if (album.shareSlug) return { slug: album.shareSlug }
    const slug = nanoid(10)
    await db()
      .update(albums)
      .set({ shareSlug: slug, updatedAt: Date.now() })
      .where(eq(albums.id, album.id))
    return { slug }
  })

export const disable = createServerFn({ method: 'POST' })
  .validator(albumIdInput)
  .handler(async ({ data }) => {
    const ownerId = await requireUser()
    const album = await ownedAlbum(data.albumId, ownerId)
    await db()
      .update(albums)
      .set({ shareSlug: null, updatedAt: Date.now() })
      .where(eq(albums.id, album.id))
    return { ok: true } as const
  })
