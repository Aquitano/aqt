import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { artwork, mediaAsset } from "@aqt/gallery-db/schema/gallery";
import sharp from "sharp";

import type { MediaStore } from "./store";

// public-image.ts imports the singleton `db`, whose module opens a real
// Postgres connection at import time. Mock the specifier before importing the
// module under test. The chainable stub mirrors exactly the drizzle calls
// sourceFor makes: db.select({...}).from(table).where(...).limit(1). `rowsFor`
// is swapped per test and keyed by the table object identity so the artwork
// query and the mediaAsset follow-up resolve independently.
type Row = Record<string, unknown>;
let rowsFor: (table: unknown) => Row[] = () => [];

await mock.module("@aqt/gallery-db", () => ({
  db: {
    select() {
      let table: unknown;
      const builder = {
        from(t: unknown) {
          table = t;
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve(rowsFor(table));
        },
      };
      return builder;
    },
  },
}));

// Dynamic import so the mock above is registered first (static imports hoist).
const { servePublicImage, warmArtworkImages } = await import("./public-image");
const { deleteArtworkCacheFiles } = await import("./delete-files");
const { createDiskStore } = await import("./store");

const realFetch = globalThis.fetch;

/** Stub the upstream image fetch and count calls, so a cache hit can assert the
 * network was not touched again. */
function stubImageFetch(bytes: Buffer, contentType = "image/png") {
  const calls = { count: 0 };
  globalThis.fetch = (async () => {
    calls.count++;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null),
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

// A literal public IP: the SSRF guard runs its address checks without the DNS
// lookup a hostname would need (which would hit the real resolver in tests and
// fail before the stubbed fetch is ever reached).
const SOURCE_URL = "https://203.0.113.7/big.png";

/** A published artwork whose image comes from a remote source URL. */
function remoteArtworkRow(over: Partial<Row> = {}): Row {
  return {
    imageUrl: SOURCE_URL,
    thumbnailUrl: null,
    isPublished: true,
    userId: "owner-1",
    primaryAssetId: null,
    ...over,
  };
}

/** A published artwork with no source URL — served from its local upload. */
function localArtworkRow(over: Partial<Row> = {}): Row {
  return {
    imageUrl: null,
    thumbnailUrl: null,
    isPublished: true,
    userId: "owner-1",
    primaryAssetId: "asset-1",
    ...over,
  };
}

const solidPng = (w: number, h: number) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();

let uploadRoot: string;
let store: MediaStore;

function baseOpts() {
  return {
    store,
    entity: "artwork" as const,
    id: "art-1",
    variant: "full" as const,
  };
}

async function metaOf(res: Response) {
  return sharp(Buffer.from(await res.arrayBuffer())).metadata();
}

beforeEach(async () => {
  uploadRoot = await mkdtemp(path.join(tmpdir(), "public-image-test-"));
  store = createDiskStore(uploadRoot);
  rowsFor = () => [];
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(uploadRoot, { recursive: true, force: true });
});

describe("servePublicImage — remote source resize cap", () => {
  test("caps a >2048px source to <=2048px webp", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow()] : []);
    stubImageFetch(await solidPng(3000, 2000));

    const res = await servePublicImage(baseOpts());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const meta = await metaOf(res);
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2048);
  });

  test("mid caps to <=1024px and caches under its own key", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow()] : []);
    stubImageFetch(await solidPng(3000, 2000));

    const res = await servePublicImage({ ...baseOpts(), variant: "mid" });

    expect(res.status).toBe(200);
    const meta = await metaOf(res);
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1024);
    expect(
      await Bun.file(
        path.join(uploadRoot, "public-image-cache", "artwork-art-1-mid-v2.webp"),
      ).exists(),
    ).toBe(true);
  });

  test("thumb caps to <=480px and caches under its own key", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow()] : []);
    stubImageFetch(await solidPng(3000, 2000));

    const res = await servePublicImage({ ...baseOpts(), variant: "thumb" });

    expect(res.status).toBe(200);
    const meta = await metaOf(res);
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(480);
    expect(
      await Bun.file(
        path.join(uploadRoot, "public-image-cache", "artwork-art-1-thumb-v2.webp"),
      ).exists(),
    ).toBe(true);
  });

  test("warmArtworkImages derives mid and full so the first visit is a cache hit", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow()] : []);
    const calls = stubImageFetch(await solidPng(3000, 2000));

    await warmArtworkImages({
      store,
      ownerId: "owner-1",
      artworkIds: ["art-1"],
    });
    const fetchedDuringWarm = calls.count;
    expect(fetchedDuringWarm).toBeGreaterThan(0);

    const mid = await servePublicImage({ ...baseOpts(), variant: "mid" });
    const full = await servePublicImage(baseOpts());

    expect(mid.status).toBe(200);
    expect(full.status).toBe(200);
    expect(calls.count).toBe(fetchedDuringWarm);
    const meta = await metaOf(mid);
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1024);
  });

  test("re-encodes a small source to webp without enlarging it", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow()] : []);
    stubImageFetch(await solidPng(512, 512));

    const res = await servePublicImage(baseOpts());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const meta = await metaOf(res);
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  test("second request serves the cached webp and revalidates to 304", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow()] : []);
    const calls = stubImageFetch(await solidPng(3000, 2000));

    const first = await servePublicImage(baseOpts());
    expect(first.status).toBe(200);
    expect(calls.count).toBe(1);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await servePublicImage(baseOpts());
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/webp");
    // The disk cache answered — upstream was not hit a second time.
    expect(calls.count).toBe(1);

    const revalidated = await servePublicImage({
      ...baseOpts(),
      ifNoneMatch: etag ?? undefined,
    });
    expect(revalidated.status).toBe(304);
    expect(calls.count).toBe(1);
  });
});

describe("servePublicImage — upstream negative cache", () => {
  test("a failed upstream is not re-fetched on the next cold request", async () => {
    // Unique URL: the negative cache is module-level state shared across
    // tests, so poisoning SOURCE_URL here would break the success-path tests.
    const badUrl = "https://203.0.113.9/broken.png";
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow({ imageUrl: badUrl })] : []);
    // A 200 with an HTML body is rejected without retries (unknown type).
    const calls = stubImageFetch(Buffer.from("<html>nope</html>"), "text/html");

    const first = await servePublicImage(baseOpts());
    expect(first.status).toBe(502);
    expect(calls.count).toBe(1);

    const second = await servePublicImage(baseOpts());
    expect(second.status).toBe(502);
    // Negative-cached — the upstream host was not contacted again.
    expect(calls.count).toBe(1);
  });
});

describe("servePublicImage — local upload resize cap", () => {
  test("caps the full-res original to webp, leaving the stored file untouched", async () => {
    const storagePath = path.join(uploadRoot, "originals", "art-1.png");
    const original = await solidPng(3000, 2000);
    await Bun.write(storagePath, original, { createPath: true });

    rowsFor = (t) => {
      if (t === artwork) return [localArtworkRow()];
      if (t === mediaAsset)
        return [
          {
            storagePath,
            thumbnailPath: path.join(uploadRoot, "thumbs", "art-1.webp"),
            mimeType: "image/png",
          },
        ];
      return [];
    };

    const res = await servePublicImage(baseOpts());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const meta = await metaOf(res);
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2048);
    // The archival original is never rewritten.
    const stored = await sharp(storagePath).metadata();
    expect(stored.format).toBe("png");
    expect(stored.width).toBe(3000);
  });
});

describe("deleteArtworkCacheFiles — primary-asset swap invalidation", () => {
  test("purges the capped cache so the next request re-derives the new asset", async () => {
    const storagePath = path.join(uploadRoot, "originals", "art-1.png");
    await Bun.write(storagePath, await solidPng(600, 400), {
      createPath: true,
    });
    rowsFor = (t) => {
      if (t === artwork) return [localArtworkRow()];
      if (t === mediaAsset)
        return [
          {
            storagePath,
            thumbnailPath: path.join(uploadRoot, "thumbs", "art-1.webp"),
            mimeType: "image/png",
          },
        ];
      return [];
    };

    await servePublicImage(baseOpts());
    const cappedFile = path.join(uploadRoot, "public-image-cache", "artwork-art-1-full-v2.webp");
    expect(await Bun.file(cappedFile).exists()).toBe(true);

    await deleteArtworkCacheFiles({ store, artworkId: "art-1" });

    expect(await Bun.file(cappedFile).exists()).toBe(false);
  });
});

describe("servePublicImage — unpublished owner-preview access control", () => {
  test("404s for a non-owner viewing an unpublished artwork", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow({ isPublished: false })] : []);
    const calls = stubImageFetch(await solidPng(512, 512));

    const res = await servePublicImage({
      ...baseOpts(),
      resolveViewer: async () => "someone-else",
    });

    expect(res.status).toBe(404);
    // Access denied before any upstream fetch.
    expect(calls.count).toBe(0);
  });

  test("serves the owner their own unpublished artwork, privately cached", async () => {
    rowsFor = (t) => (t === artwork ? [remoteArtworkRow({ isPublished: false })] : []);
    stubImageFetch(await solidPng(512, 512));

    const res = await servePublicImage({
      ...baseOpts(),
      resolveViewer: async () => "owner-1",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
  });
});
