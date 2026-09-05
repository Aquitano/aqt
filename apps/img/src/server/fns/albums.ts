import { createServerFn } from '@tanstack/react-start'
import { type } from 'arktype'
import { cover } from '@/domain/element'
import * as albumsService from '@/server/albums'
import { requireUser } from '@/server/auth'

const albumIdInput = type({ albumId: 'string' })

export const list = createServerFn({ method: 'GET' }).handler(async () =>
  albumsService.listAlbums(await requireUser()),
)

export const get = createServerFn({ method: 'GET' })
  .validator(albumIdInput)
  .handler(async ({ data }) => albumsService.getAlbum(data.albumId, await requireUser()))

export const getShared = createServerFn({ method: 'GET' })
  .validator(type({ slug: 'string' }))
  .handler(({ data }) => albumsService.getSharedAlbum(data.slug))

export const create = createServerFn({ method: 'POST' })
  .validator(type({ title: 'string > 0', cover }))
  .handler(async ({ data }) => albumsService.createAlbum(await requireUser(), data))

export const update = createServerFn({ method: 'POST' })
  .validator(type({ albumId: 'string', 'title?': 'string > 0', 'cover?': cover }))
  .handler(async ({ data: { albumId, ...patch } }) => {
    await albumsService.updateAlbum(albumId, await requireUser(), patch)
    return { ok: true } as const
  })

export const remove = createServerFn({ method: 'POST' })
  .validator(albumIdInput)
  .handler(async ({ data }) => {
    await albumsService.deleteAlbum(data.albumId, await requireUser())
    return { ok: true } as const
  })
