import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { deleteArtworkCacheFiles } from "./delete-files";
import { servePublicImage, warmArtworkImages } from "./public-image";
import type { ImageRows } from "./rows";
import { createDiskStore, type MediaStore } from "./store";

type ArtworkRow = NonNullable<Awaited<ReturnType<ImageRows["artwork"]>>>;
type AssetRow = NonNullable<Awaited<ReturnType<ImageRows["mediaAsset"]>>>;

const noRows: ImageRows = {
  artwork: async () => undefined,
  mediaAsset: async () => undefined,
  exhibitionCover: async () => undefined,
};
let rows = noRows;

function artworkRows(row: ArtworkRow, asset?: AssetRow): ImageRows {
  return { ...noRows, artwork: async () => row, mediaAsset: async () => asset };
}

const realFetch = globalThis.fetch;

/** Stub the upstream image fetch and count calls, so a cache hit can assert the
 * network was not touched again. */
function stubImageFetch(bytes: Buffer, contentType = "image/png") {
  const calls = { count: 0 };
  globalThis.fetch = Object.assign(
    async () => {
      calls.count++;
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": contentType },
      });
    },
    { preconnect: realFetch.preconnect },
  );
  return calls;
}

// A literal public IP: the SSRF guard runs its address checks without the DNS
// lookup a hostname would need (which would hit the real resolver in tests and
// fail before the stubbed fetch is ever reached).
const SOURCE_URL = "https://203.0.113.7/big.png";

/** A published artwork whose image comes from a remote source URL. */
function remoteArtworkRow(over: Partial<ArtworkRow> = {}): ArtworkRow {
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
function localArtworkRow(over: Partial<ArtworkRow> = {}): ArtworkRow {
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
    rows,
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
  rows = noRows;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(uploadRoot, { recursive: true, force: true });
});

describe("servePublicImage — remote source resize cap", () => {
  test("caps a >2048px source to <=2048px webp", async () => {
    rows = artworkRows(remoteArtworkRow());
    stubImageFetch(await solidPng(3000, 2000));

    const res = await servePublicImage(baseOpts());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const meta = await metaOf(res);
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2048);
  });

  test("mid caps to <=1024px and caches under its own key", async () => {
    rows = artworkRows(remoteArtworkRow());
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
    rows = artworkRows(remoteArtworkRow());
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
    rows = artworkRows(remoteArtworkRow());
    const calls = stubImageFetch(await solidPng(3000, 2000));

    await warmArtworkImages({
      store,
      rows,
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
    rows = artworkRows(remoteArtworkRow());
    stubImageFetch(await solidPng(512, 512));

    const res = await servePublicImage(baseOpts());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const meta = await metaOf(res);
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  test("second request serves the cached webp and revalidates to 304", async () => {
    rows = artworkRows(remoteArtworkRow());
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
    rows = artworkRows(remoteArtworkRow({ imageUrl: badUrl }));
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

    rows = artworkRows(localArtworkRow(), {
      storagePath,
      thumbnailPath: path.join(uploadRoot, "thumbs", "art-1.webp"),
      mimeType: "image/png",
    });

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
    rows = artworkRows(localArtworkRow(), {
      storagePath,
      thumbnailPath: path.join(uploadRoot, "thumbs", "art-1.webp"),
      mimeType: "image/png",
    });

    await servePublicImage(baseOpts());
    const cappedFile = path.join(uploadRoot, "public-image-cache", "artwork-art-1-full-v2.webp");
    expect(await Bun.file(cappedFile).exists()).toBe(true);

    await deleteArtworkCacheFiles({ store, artworkId: "art-1" });

    expect(await Bun.file(cappedFile).exists()).toBe(false);
  });
});

describe("servePublicImage — unpublished owner-preview access control", () => {
  test("404s for a non-owner viewing an unpublished artwork", async () => {
    rows = artworkRows(remoteArtworkRow({ isPublished: false }));
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
    rows = artworkRows(remoteArtworkRow({ isPublished: false }));
    stubImageFetch(await solidPng(512, 512));

    const res = await servePublicImage({
      ...baseOpts(),
      resolveViewer: async () => "owner-1",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
  });
});
