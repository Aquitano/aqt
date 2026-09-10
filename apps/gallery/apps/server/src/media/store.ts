import { rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { env } from "@aqt/gallery-env/server";

/**
 * Every media byte the server writes or reads goes through a MediaStore, keyed
 * by a "/"-separated relative object key (`originals/<userId>/<assetId>.jpg`,
 * `public-image-cache/<entity>-<id>-<variant>-<version>.webp`). Production runs
 * on S3-compatible object storage (Cloudflare R2); development and tests run on
 * a local directory with the same keys as file paths.
 */

export type StoredObject = {
  stream: ReadableStream<Uint8Array>;
  size: number;
  etag: string;
  contentType?: string;
};

export type MediaStore = {
  put(key: string, body: Uint8Array | ArrayBuffer | Blob, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
};

/** Cheap, stable validator from a file's size + mtime — no need to hash
 * megabytes of image bytes on every hot-path request. Like nginx/Apache default
 * ETags this assumes one instance over one local directory: the mtime differs
 * per replica, so a multi-instance disk deployment would need a content hash.
 * The S3 backend uses the object's own ETag instead. */
function diskEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}"`;
}

/** Object keys are relative and "/"-separated; a `.` or `..` segment would let
 * a crafted key escape the storage root. */
function keyToPath(root: string, key: string): string {
  const segments = key.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid media key: ${key}`);
  }
  return path.join(root, ...segments);
}

export function createDiskStore(root: string): MediaStore {
  return {
    async put(key, body, _contentType) {
      // Temp + rename so a concurrent reader can never stream a half-written
      // object — Bun.write truncates in place.
      const filePath = keyToPath(root, key);
      const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
      await Bun.write(tmp, body, { createPath: true });
      await rename(tmp, filePath);
    },
    async get(key) {
      const filePath = keyToPath(root, key);
      const stats = await stat(filePath).catch(() => null);
      if (!stats?.isFile()) return null;
      return {
        stream: Bun.file(filePath).stream(),
        size: stats.size,
        etag: diskEtag(stats.size, stats.mtimeMs),
      };
    },
    async head(key) {
      const stats = await stat(keyToPath(root, key)).catch(() => null);
      if (!stats?.isFile()) return null;
      return { size: stats.size, etag: diskEtag(stats.size, stats.mtimeMs) };
    },
    async delete(key) {
      await unlink(keyToPath(root, key)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
    async deletePrefix(prefix) {
      await rm(keyToPath(root, prefix), { recursive: true, force: true });
    },
  };
}

/** S3 returns ETags already wrapped in quotes, but not every S3-compatible
 * implementation does; normalise so the value we send is a valid RFC 7232
 * entity-tag either way. */
function quotedEtag(raw?: string | null): string {
  if (!raw) return '""';
  const trimmed = raw.trim();
  return trimmed.startsWith('"') ? trimmed : `"${trimmed}"`;
}

const DELETE_CONCURRENCY = 32;

export function createS3Store(client: Bun.S3Client): MediaStore {
  const statOrNull = (file: Bun.S3File) => file.stat().catch(() => null);
  return {
    async put(key, body, contentType) {
      await client.write(key, body, { type: contentType });
    },
    async get(key) {
      const file = client.file(key);
      const stats = await statOrNull(file);
      if (!stats) return null;
      return {
        stream: file.stream(),
        size: stats.size,
        etag: quotedEtag(stats.etag),
        contentType: stats.type,
      };
    },
    async head(key) {
      const stats = await statOrNull(client.file(key));
      if (!stats) return null;
      return { size: stats.size, etag: quotedEtag(stats.etag) };
    },
    async delete(key) {
      await client.delete(key);
    },
    async deletePrefix(prefix) {
      if (!prefix || prefix.trim() === "") {
        throw new Error("deletePrefix requires a non-empty prefix");
      }
      let continuationToken: string | undefined;
      do {
        const page = await client.list({ prefix, continuationToken });
        const keys = page.contents?.map((object) => object.key) ?? [];
        for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
          await Promise.all(keys.slice(i, i + DELETE_CONCURRENCY).map((key) => client.delete(key)));
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
    },
  };
}

/** The configured bucket, or null when the S3 vars are unset and media lives
 * under UPLOAD_DIR. The env schema already rejects a partial configuration. */
export function s3ClientFromEnv(): Bun.S3Client | null {
  const { S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_BUCKET || !S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    return null;
  }
  return new Bun.S3Client({
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
  });
}

const s3Client = s3ClientFromEnv();

export const mediaStore: MediaStore = s3Client
  ? createS3Store(s3Client)
  : createDiskStore(path.resolve(env.UPLOAD_DIR));
