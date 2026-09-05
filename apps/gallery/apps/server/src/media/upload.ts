import { lookup } from "node:dns/promises";
import { mkdir, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { db } from "@aqt/gallery-db";
import { artwork, mediaAsset } from "@aqt/gallery-db/schema/gallery";
import { Data, Effect } from "effect";
import sharp from "sharp";

import { filenameTitle } from "../api/routers/gallery-helpers";

const maxFilesPerUpload = 25;
const maxFileSizeBytes = 25 * 1024 * 1024;

const imageMimeExtensions = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

declare const emptyFields: unique symbol;
type EmptyFields = { readonly [emptyFields]?: never };

export class NoFilesSupplied extends Data.TaggedError("NoFilesSupplied")<EmptyFields> {}

export class TooManyFiles extends Data.TaggedError("TooManyFiles")<{
  readonly maxFiles: number;
}> {}

export class FileTooLarge extends Data.TaggedError("FileTooLarge")<{
  readonly filename: string;
  readonly maxFileSizeBytes: number;
}> {}

export class UnsupportedFileType extends Data.TaggedError("UnsupportedFileType")<{
  readonly filename: string;
  readonly mimeType: string;
}> {}

export class ImageProcessingFailed extends Data.TaggedError("ImageProcessingFailed")<{
  readonly filename: string;
  readonly cause: unknown;
}> {}

export class StorageWriteFailed extends Data.TaggedError("StorageWriteFailed")<{
  readonly filename: string;
  readonly cause: unknown;
}> {}

export class DatabaseWriteFailed extends Data.TaggedError("DatabaseWriteFailed")<{
  readonly cause: unknown;
}> {}

export class RemoteFetchFailed extends Data.TaggedError("RemoteFetchFailed")<{
  readonly url: string;
  readonly status?: number;
}> {}

export type UploadError =
  | NoFilesSupplied
  | TooManyFiles
  | FileTooLarge
  | UnsupportedFileType
  | ImageProcessingFailed
  | StorageWriteFailed
  | DatabaseWriteFailed
  | RemoteFetchFailed;

type UploadFile = {
  readonly artworkId: string;
  readonly assetId: string;
  readonly title: string;
  readonly extension: string;
  readonly originalPath: string;
  readonly thumbnailPath: string;
  readonly buffer: Buffer;
  readonly thumbnailBuffer: Buffer;
  readonly width: number | null;
  readonly height: number | null;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize: number;
};

export type UploadedArtwork = {
  readonly artworkId: string;
  readonly asset: typeof mediaAsset.$inferSelect;
  readonly title: string;
};

export type UploadMediaInput = {
  readonly formData: FormData;
  readonly uploadRoot: string;
  readonly userId: string;
};

function uploadDirs(uploadRoot: string, userId: string) {
  return {
    originalsDir: path.join(uploadRoot, "originals", userId),
    thumbsDir: path.join(uploadRoot, "thumbs", userId),
  };
}

function deleteIfExists(filePath: string) {
  return Effect.tryPromise({
    try: () =>
      unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }),
    catch: (cause) => cause,
  });
}

function cleanupFiles(files: ReadonlyArray<Pick<UploadFile, "originalPath" | "thumbnailPath">>) {
  return Effect.all(
    files.flatMap((file) => [
      deleteIfExists(file.originalPath),
      deleteIfExists(file.thumbnailPath),
    ]),
    { concurrency: 4 },
  ).pipe(Effect.orDie);
}

/** Pairs each uploaded file with its optional title and filters both in
 * lockstep, so a dropped (empty) file can never shift the titles out of
 * alignment with the files that survive. */
function filesFromFormData(formData: FormData) {
  const rawTitles = formData.getAll("titles");
  const entries = formData
    .getAll("files")
    .map((value, index) => {
      const rawTitle = rawTitles[index];
      return { value, title: typeof rawTitle === "string" ? rawTitle : undefined };
    })
    .filter(
      (entry): entry is { value: File; title: string | undefined } =>
        entry.value instanceof File && entry.value.size > 0,
    );

  if (entries.length === 0) {
    return Effect.fail(new NoFilesSupplied({}));
  }

  if (entries.length > maxFilesPerUpload) {
    return Effect.fail(new TooManyFiles({ maxFiles: maxFilesPerUpload }));
  }

  return Effect.succeed(entries);
}

/** Shared ingest core: validates an in-memory image, derives a thumbnail,
 * and produces an unwritten UploadFile. Both browser uploads and remote
 * URL imports funnel through here so a downloaded image is stored exactly
 * like an uploaded one. */
function prepareImage(
  uploadRoot: string,
  userId: string,
  input: {
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly filename: string;
    readonly title?: string;
  },
) {
  return Effect.gen(function* () {
    if (input.bytes.byteLength > maxFileSizeBytes) {
      return yield* new FileTooLarge({
        filename: input.filename,
        maxFileSizeBytes,
      });
    }

    const extension = imageMimeExtensions.get(input.mimeType);

    if (!extension) {
      return yield* new UnsupportedFileType({
        filename: input.filename,
        mimeType: input.mimeType,
      });
    }

    const artworkId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const { originalsDir, thumbsDir } = uploadDirs(uploadRoot, userId);
    const originalPath = path.join(originalsDir, `${assetId}.${extension}`);
    const thumbnailPath = path.join(thumbsDir, `${assetId}.webp`);
    const animated = input.mimeType === "image/gif";

    const metadata = yield* Effect.tryPromise({
      try: () => sharp(input.bytes, { animated }).metadata(),
      catch: (cause) => new ImageProcessingFailed({ filename: input.filename, cause }),
    });
    const thumbnailBuffer = yield* Effect.tryPromise({
      try: () =>
        sharp(input.bytes, { animated })
          .resize({
            width: 900,
            height: 1200,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toBuffer(),
      catch: (cause) => new ImageProcessingFailed({ filename: input.filename, cause }),
    });

    return {
      artworkId,
      assetId,
      title: input.title?.trim() || filenameTitle(input.filename) || "Untitled artwork",
      extension,
      originalPath,
      thumbnailPath,
      buffer: input.bytes,
      thumbnailBuffer,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      originalFilename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
    } satisfies UploadFile;
  });
}

function prepareUploadFile(uploadRoot: string, userId: string, file: File, title?: string) {
  return Effect.gen(function* () {
    if (file.size > maxFileSizeBytes) {
      return yield* new FileTooLarge({ filename: file.name, maxFileSizeBytes });
    }
    const bytes = yield* Effect.tryPromise({
      try: async () => Buffer.from(await file.arrayBuffer()),
      catch: (cause) => new ImageProcessingFailed({ filename: file.name, cause }),
    });
    return yield* prepareImage(uploadRoot, userId, {
      bytes,
      mimeType: file.type,
      filename: file.name,
      title,
    });
  });
}

function filenameFromUrl(url: string) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "imported-image";
  } catch {
    return "imported-image";
  }
}

const IMAGE_FETCH_USER_AGENT = "aqt-gallery/1.0 (museum image import)";
const MAX_IMAGE_FETCH_REDIRECTS = 5;

/**
 * Reject loopback, link-local (incl. the 169.254.169.254 cloud-metadata
 * endpoint), private, CGNAT, and reserved ranges so a server-side image fetch
 * can't be steered at internal infrastructure (SSRF). Defence-in-depth: a
 * resolve-then-fetch check still leaves a narrow DNS-rebinding window, but it
 * closes the practical vectors (literal IPs, internal DNS names, metadata IPs,
 * and redirect-to-internal hops).
 */
function isBlockedAddress(ip: string): boolean {
  if (ip.includes(".")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  const v6 = (ip.toLowerCase().split("%")[0] ?? "").trim();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fe80")) return true; // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  return false;
}

/** http(s) only, and every IP the host resolves to must be public. */
async function assertFetchableUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // unwrap [ipv6]
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error("URL resolves to a non-public address");
    }
    return;
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error("Host did not resolve");
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error("URL resolves to a non-public address");
    }
  }
}

/** Fetch an image, validating the initial URL and every redirect hop against
 * SSRF before each request (redirects are followed manually so an internal
 * target can't be reached via a public-looking URL). */
async function fetchImageGuarded(initialUrl: string): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_IMAGE_FETCH_REDIRECTS; hop++) {
    await assertFetchableUrl(current);
    const res = await fetch(current, {
      headers: { "User-Agent": IMAGE_FETCH_USER_AGENT },
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/** Buffers the body while enforcing the size cap up front (Content-Length) and
 * per-chunk, so a length-lying response can't be fully buffered before
 * prepareImage's check. Null if exceeded. */
async function readImageBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.byteLength > maxBytes ? null : bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let read = await reader.read();
  while (!read.done) {
    total += read.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(read.value));
    read = await reader.read();
  }
  return Buffer.concat(chunks);
}

/** Downloads a remote image once and routes it through the shared ingest,
 * so the gallery never depends on a live third-party URL afterwards. */
function prepareUrlImage(
  uploadRoot: string,
  userId: string,
  item: { readonly url: string; readonly title?: string },
) {
  return Effect.gen(function* () {
    const fetched = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetchImageGuarded(item.url);
        if (!res.ok) {
          return {
            ok: false as const,
            reason: "http" as const,
            status: res.status,
          };
        }
        const contentType =
          res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
        const bytes = await readImageBodyCapped(res, maxFileSizeBytes);
        if (!bytes) {
          return { ok: false as const, reason: "too-large" as const };
        }
        return { ok: true as const, contentType, bytes };
      },
      catch: () => new RemoteFetchFailed({ url: item.url }),
    });
    if (!fetched.ok) {
      if (fetched.reason === "too-large") {
        return yield* new FileTooLarge({
          filename: filenameFromUrl(item.url),
          maxFileSizeBytes,
        });
      }
      return yield* new RemoteFetchFailed({
        url: item.url,
        status: fetched.status,
      });
    }
    return yield* prepareImage(uploadRoot, userId, {
      bytes: fetched.bytes,
      mimeType: fetched.contentType,
      filename: filenameFromUrl(item.url),
      title: item.title,
    });
  });
}

function writeUploadFiles(files: ReadonlyArray<UploadFile>) {
  return Effect.tryPromise({
    try: async () => {
      for (const file of files) {
        await mkdir(path.dirname(file.originalPath), { recursive: true });
        await mkdir(path.dirname(file.thumbnailPath), { recursive: true });
        await Bun.write(file.originalPath, file.buffer);
        await Bun.write(file.thumbnailPath, file.thumbnailBuffer);
      }
      return files;
    },
    catch: (cause) => new StorageWriteFailed({ filename: "upload", cause }),
  }).pipe(Effect.tapError(() => cleanupFiles(files)));
}

function insertUploadedArtworks(userId: string, files: ReadonlyArray<UploadFile>) {
  return Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const uploaded: UploadedArtwork[] = [];

        for (const file of files) {
          await tx.insert(artwork).values({
            id: file.artworkId,
            userId,
            title: file.title,
            artworkType: "other",
            primaryAssetId: file.assetId,
          });

          const rows = await tx
            .insert(mediaAsset)
            .values({
              id: file.assetId,
              userId,
              artworkId: file.artworkId,
              originalFilename: file.originalFilename,
              mimeType: file.mimeType,
              byteSize: file.byteSize,
              width: file.width,
              height: file.height,
              storagePath: file.originalPath,
              thumbnailPath: file.thumbnailPath,
            })
            .returning();

          const asset = rows[0];

          if (!asset) {
            throw new Error("Media asset insert returned no rows");
          }

          uploaded.push({
            artworkId: file.artworkId,
            asset,
            title: file.title,
          });
        }

        return uploaded;
      }),
    catch: (cause) => new DatabaseWriteFailed({ cause }),
  }).pipe(Effect.tapError(() => cleanupFiles(files)));
}

export function uploadMedia({ formData, uploadRoot, userId }: UploadMediaInput) {
  return Effect.gen(function* () {
    const entries = yield* filesFromFormData(formData);
    const prepared = yield* Effect.all(
      entries.map((entry) =>
        prepareUploadFile(uploadRoot, userId, entry.value, entry.title || undefined),
      ),
      {
        concurrency: 2,
      },
    );

    yield* writeUploadFiles(prepared);
    return yield* insertUploadedArtworks(userId, prepared);
  });
}

export type ImportUrlsInput = {
  readonly items: ReadonlyArray<{
    readonly url: string;
    readonly title?: string;
  }>;
  readonly uploadRoot: string;
  readonly userId: string;
};

/** Import flow for remote images: each URL is downloaded once, processed,
 * and stored as a media asset — identical on-disk result to an upload, so
 * the rest of the app never sees the external URL. */
export function importMediaFromUrls({ items, uploadRoot, userId }: ImportUrlsInput) {
  return Effect.gen(function* () {
    if (items.length === 0) {
      return yield* new NoFilesSupplied({});
    }
    if (items.length > maxFilesPerUpload) {
      return yield* new TooManyFiles({ maxFiles: maxFilesPerUpload });
    }
    const prepared = yield* Effect.all(
      items.map((item) => prepareUrlImage(uploadRoot, userId, item)),
      { concurrency: 2 },
    );
    yield* writeUploadFiles(prepared);
    return yield* insertUploadedArtworks(userId, prepared);
  });
}

export function uploadErrorResponse(error: UploadError) {
  switch (error._tag) {
    case "NoFilesSupplied":
      return { status: 400 as const, body: { error: "No files supplied" } };
    case "TooManyFiles":
      return {
        status: 400 as const,
        body: { error: `Upload at most ${error.maxFiles} files at a time` },
      };
    case "FileTooLarge":
      return {
        status: 413 as const,
        body: {
          error: `${error.filename} exceeds the ${Math.floor(error.maxFileSizeBytes / 1024 / 1024)}MB limit`,
        },
      };
    case "UnsupportedFileType":
      return {
        status: 415 as const,
        body: {
          error: `Unsupported file type: ${error.mimeType || error.filename}`,
        },
      };
    case "ImageProcessingFailed":
      return {
        status: 400 as const,
        body: { error: `Could not process image: ${error.filename}` },
      };
    case "RemoteFetchFailed":
      return {
        status: 502 as const,
        body: {
          error: `Could not download image${error.status ? ` (HTTP ${error.status})` : ""}`,
        },
      };
    case "StorageWriteFailed":
    case "DatabaseWriteFailed":
      return { status: 500 as const, body: { error: "Upload failed" } };
  }
}
