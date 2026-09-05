import { env } from "cloudflare:workers";

export type StoredObject = {
  body: ReadableStream;
  contentType: string | undefined;
  size: number;
};

/**
 * The seam between the app and object storage. Swapping in presigned URLs or
 * Cloudflare Images later means implementing this, not touching call sites.
 */
export interface Storage {
  put(key: string, body: ReadableStream, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export const storage: Storage = {
  async put(key, body, contentType) {
    await env.PHOTOS.put(key, body, { httpMetadata: { contentType } });
  },
  async get(key) {
    const object = await env.PHOTOS.get(key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType,
      size: object.size,
    };
  },
  async delete(key) {
    await env.PHOTOS.delete(key);
  },
};

export function photoKeys(ownerId: string, photoId: string) {
  return {
    key: `photos/${ownerId}/${photoId}.jpg`,
    thumbKey: `photos/${ownerId}/${photoId}.thumb.jpg`,
  };
}
