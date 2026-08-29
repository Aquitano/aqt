import { createFileRoute } from '@tanstack/react-router'
import { and, eq, isNotNull, like } from 'drizzle-orm'
import { currentUserId } from '@/server/auth'
import { db } from '@/server/db/client'
import { albums, photos, spreads } from '@/server/db/schema'
import { storage } from '@/server/storage'

/** `?thumb=1` addresses the 400px thumbnail instead of the display image. */
function wantsThumb(url: string) {
  return new URL(url).searchParams.get('thumb') === '1'
}

/**
 * A photo is readable by its owner, or by anyone once it sits on a spread of an
 * album that has link sharing on. Same `LIKE` on the elements JSON that the
 * delete guard uses; good enough at this scale.
 */
async function isOnASharedSpread(photoId: string) {
  const [row] = await db()
    .select({ id: spreads.id })
    .from(spreads)
    .innerJoin(albums, eq(albums.id, spreads.albumId))
    .where(
      and(
        isNotNull(albums.shareSlug),
        like(spreads.elements, `%"photoId":"${photoId}"%`),
      ),
    )
    .limit(1)
  return row !== undefined
}

export const Route = createFileRoute('/api/photos/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const [photo] = await db()
          .select()
          .from(photos)
          .where(eq(photos.id, params.id))
        if (!photo) return new Response('Not found', { status: 404 })

        const viewerId = await currentUserId()
        const allowed =
          photo.ownerId === viewerId || (await isOnASharedSpread(photo.id))
        if (!allowed) return new Response('Not found', { status: 404 })

        const object = await storage.get(
          wantsThumb(request.url) ? photo.thumbKey : photo.key,
        )
        if (!object) return new Response('Not found', { status: 404 })

        return new Response(object.body, {
          headers: {
            'Content-Type': object.contentType ?? 'image/jpeg',
            'Content-Length': String(object.size),
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      },

      PUT: async ({ request, params }) => {
        const ownerId = await currentUserId()
        if (!ownerId) return new Response('Unauthorized', { status: 401 })
        if (!request.body) return new Response('Empty body', { status: 400 })

        const [photo] = await db()
          .select()
          .from(photos)
          .where(and(eq(photos.id, params.id), eq(photos.ownerId, ownerId)))
        if (!photo) return new Response('Not found', { status: 404 })

        await storage.put(
          wantsThumb(request.url) ? photo.thumbKey : photo.key,
          request.body,
          request.headers.get('Content-Type') ?? 'image/jpeg',
        )
        return new Response(null, { status: 204 })
      },
    },
  },
})
