import type { AlbumInput, AlbumPatch, BookInput, PhotoInput } from '@/domain/api'
import type { Album, Photo, Spread } from '@/server/db/schema'
import type { Config } from './config'

/** Server rejected a request; `status` and `message` are the API's own. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type Book = { album: Album; spreads: Spread[] }
type ReservedPhoto = Photo & { uploadUrl: string; thumbUploadUrl: string }

/** Typed wrapper over `/api/v1` plus the photo byte endpoints. */
export function createClient({ url, key }: Config) {
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const message = await res
        .json()
        .then((data: { error?: string }) => data.error)
        .catch(() => undefined)
      throw new ApiError(res.status, message ?? `${res.status} ${res.statusText}`)
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
  }

  const upload = async (path: string, bytes: Uint8Array) => {
    const res = await fetch(`${url}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'image/jpeg' },
      // A fresh copy is backed by a plain ArrayBuffer, which is what fetch accepts.
      body: new Uint8Array(bytes),
    })
    if (!res.ok) throw new ApiError(res.status, `Upload failed (${res.status})`)
  }

  return {
    url,
    me: () => request<{ userId: string }>('GET', '/api/v1/me'),
    albums: {
      list: () => request<Album[]>('GET', '/api/v1/albums'),
      create: (input: AlbumInput) => request<Album>('POST', '/api/v1/albums', input),
      get: (albumId: string) => request<Book>('GET', `/api/v1/albums/${albumId}`),
      update: (albumId: string, patch: AlbumPatch) =>
        request<Album>('PATCH', `/api/v1/albums/${albumId}`, patch),
      delete: (albumId: string) => request<void>('DELETE', `/api/v1/albums/${albumId}`),
      putBook: (albumId: string, book: BookInput) =>
        request<Book>('PUT', `/api/v1/albums/${albumId}/book`, book),
      share: (albumId: string) =>
        request<{ slug: string; url: string }>('POST', `/api/v1/albums/${albumId}/share`),
      unshare: (albumId: string) => request<void>('DELETE', `/api/v1/albums/${albumId}/share`),
    },
    photos: {
      list: () => request<Photo[]>('GET', '/api/v1/photos'),
      delete: (photoId: string) => request<void>('DELETE', `/api/v1/photos/${photoId}`),
      /** Reserves a row, then uploads both renditions. */
      async import(input: PhotoInput, display: Uint8Array, thumb: Uint8Array) {
        const photo = await request<ReservedPhoto>('POST', '/api/v1/photos', input)
        await Promise.all([upload(photo.uploadUrl, display), upload(photo.thumbUploadUrl, thumb)])
        return photo
      },
    },
  }
}

export type Client = ReturnType<typeof createClient>
