import { type, type Type } from "arktype";

import type { AlbumInput, AlbumPatch, BookInput, PhotoInput } from "@/domain/api";
import { cover, elementList } from "@/domain/element";

import type { Config } from "./config";

/** Server rejected a request; `status` and `message` are the API's own. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** What `/api/v1` sends back, limited to the fields the CLI reads. */
const albumRow = type({
  id: "string",
  title: "string",
  cover,
  shareSlug: "string | null",
  updatedAt: "number",
});

const spreadRow = type({ id: "string", elements: elementList });

const photoRow = type({
  id: "string",
  width: "number",
  height: "number",
  takenAt: "number | null",
});

/** A reserved row comes with the two one-shot upload URLs for its renditions. */
const reservedPhotoRow = photoRow.and({ uploadUrl: "string", thumbUploadUrl: "string" });

const bookOfAlbum = type({ album: albumRow, spreads: spreadRow.array() });

const identity = type({ userId: "string" });

const shareLink = type({ slug: "string", url: "string" });

export type Album = typeof albumRow.infer;
export type Photo = typeof photoRow.infer;
export type Book = typeof bookOfAlbum.infer;

type RequestBody = AlbumInput | AlbumPatch | BookInput | PhotoInput;

/** Typed wrapper over `/api/v1` plus the photo byte endpoints. */
export function createClient({ url, key }: Config) {
  const headers = { Authorization: `Bearer ${key}` };

  const send = async (method: string, path: string, body?: RequestBody) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const message = await res
        .json()
        .then((data: { error?: string }) => data.error)
        .catch(() => undefined);
      throw new ApiError(res.status, message ?? `${res.status} ${res.statusText}`);
    }
    return res;
  };

  const request = async <T extends Type>(
    method: string,
    path: string,
    schema: T,
    body?: RequestBody,
  ): Promise<T["infer"]> => {
    const res = await send(method, path, body);
    const parsed = schema(await res.json());
    if (parsed instanceof type.errors) {
      throw new ApiError(res.status, `Unexpected response from ${path}:\n${parsed.summary}`);
    }
    return parsed;
  };

  /** Endpoints that answer 204 and have nothing to decode. */
  const command = async (method: string, path: string) => {
    await send(method, path);
  };

  const upload = async (path: string, bytes: Uint8Array) => {
    const res = await fetch(`${url}${path}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "image/jpeg" },
      // A fresh copy is backed by a plain ArrayBuffer, which is what fetch accepts.
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new ApiError(res.status, `Upload failed (${res.status})`);
  };

  return {
    url,
    /** For clients that fetch pages themselves, such as the PDF exporter. */
    headers,
    me: () => request("GET", "/api/v1/me", identity),
    albums: {
      list: () => request("GET", "/api/v1/albums", albumRow.array()),
      create: (input: AlbumInput) => request("POST", "/api/v1/albums", albumRow, input),
      get: (albumId: string) => request("GET", `/api/v1/albums/${albumId}`, bookOfAlbum),
      update: (albumId: string, patch: AlbumPatch) =>
        request("PATCH", `/api/v1/albums/${albumId}`, albumRow, patch),
      delete: (albumId: string) => command("DELETE", `/api/v1/albums/${albumId}`),
      putBook: (albumId: string, book: BookInput) =>
        request("PUT", `/api/v1/albums/${albumId}/book`, bookOfAlbum, book),
      share: (albumId: string) => request("POST", `/api/v1/albums/${albumId}/share`, shareLink),
      unshare: (albumId: string) => command("DELETE", `/api/v1/albums/${albumId}/share`),
    },
    photos: {
      list: () => request("GET", "/api/v1/photos", photoRow.array()),
      delete: (photoId: string) => command("DELETE", `/api/v1/photos/${photoId}`),
      /** Reserves a row, then uploads both renditions. */
      async import(input: PhotoInput, display: Uint8Array, thumb: Uint8Array) {
        const photo = await request("POST", "/api/v1/photos", reservedPhotoRow, input);
        await Promise.all([upload(photo.uploadUrl, display), upload(photo.thumbUploadUrl, thumb)]);
        return photo;
      },
    },
  };
}

export type Client = ReturnType<typeof createClient>;
