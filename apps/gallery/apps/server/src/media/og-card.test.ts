import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { deleteEntityCacheFiles } from "./delete-files";
import { ogCardCacheTargets, serveOgCard } from "./og-card";
import type { MediaRows } from "./rows";
import { createDiskStore, type MediaStore } from "./store";

type ExhibitionRow = NonNullable<Awaited<ReturnType<MediaRows["exhibitionBySlug"]>>>;
type ArtworkRow = NonNullable<Awaited<ReturnType<MediaRows["artwork"]>>>;

const noRows: MediaRows = {
  artwork: async () => undefined,
  mediaAsset: async () => undefined,
  exhibitionCover: async () => undefined,
  exhibitionBySlug: async () => undefined,
  roomIds: async () => [],
  placedArtworkIds: async () => [],
};
let rows = noRows;

/** The cache key of a card, as a path under the temp disk root. */
function cardFile(root: string, id: string): string {
  return path.join(root, ogCardCacheTargets(id)[0] ?? "");
}

const realFetch = globalThis.fetch;

/** Stub the upstream cover fetch and count calls, so a cached card can assert
 * the network was not touched again. */
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

// A literal public IP so the SSRF guard skips the DNS lookup a hostname would
// need (it would hit the real resolver in tests).
const COVER_URL = "https://203.0.113.7/cover.png";

const solidPng = (w: number, h: number) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 90, g: 40, b: 20 },
    },
  })
    .png()
    .toBuffer();

/** A published exhibition whose cover is a member artwork served from a remote
 * source URL. */
function publishedExhibitionRow(over: Partial<ExhibitionRow> = {}): ExhibitionRow {
  return {
    id: "exh-1",
    kind: "exhibition",
    name: "Impressionist Wing",
    tagline: "Light and colour",
    description: "A walk through late 19th-century painting.",
    theme: { wallColor: "#2b2016" },
    coverImageUrl: null,
    coverArtworkId: "art-1",
    isPublished: true,
    ...over,
  };
}

function coverArtworkRow(over: Partial<ArtworkRow> = {}): ArtworkRow {
  return {
    imageUrl: COVER_URL,
    thumbnailUrl: null,
    isPublished: true,
    userId: "owner-1",
    primaryAssetId: null,
    ...over,
  };
}

/** Rows for a card render: the exhibition, one room, one placement (also the
 * cover artwork), and that artwork's source. */
function wireExhibition(exhibitionOver: Partial<ExhibitionRow> = {}) {
  rows = {
    ...noRows,
    exhibitionBySlug: async () => publishedExhibitionRow(exhibitionOver),
    roomIds: async () => ["room-1"],
    placedArtworkIds: async () => ["art-1"],
    artwork: async () => coverArtworkRow(),
  };
}

let uploadRoot: string;
let store: MediaStore;

async function metaOf(res: Response) {
  return sharp(Buffer.from(await res.arrayBuffer())).metadata();
}

beforeEach(async () => {
  uploadRoot = await mkdtemp(path.join(tmpdir(), "og-card-test-"));
  store = createDiskStore(uploadRoot);
  rows = noRows;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(uploadRoot, { recursive: true, force: true });
});

describe("serveOgCard — compose and cache", () => {
  test("composes a 1200x630 png and caches it to disk", async () => {
    wireExhibition();
    stubImageFetch(await solidPng(600, 400));

    const res = await serveOgCard({ store, rows, slug: "wing" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const meta = await metaOf(res);
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);

    expect(await Bun.file(cardFile(uploadRoot, "exh-1")).exists()).toBe(true);
  });

  test("second request serves the cached card and revalidates to 304", async () => {
    wireExhibition();
    const calls = stubImageFetch(await solidPng(600, 400));

    const first = await serveOgCard({ store, rows, slug: "wing" });
    expect(first.status).toBe(200);
    expect(calls.count).toBe(1);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await serveOgCard({ store, rows, slug: "wing" });
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/png");
    // The disk cache answered — the cover was not fetched again.
    expect(calls.count).toBe(1);

    const revalidated = await serveOgCard({
      store,
      rows,
      slug: "wing",
      ifNoneMatch: etag ?? undefined,
    });
    expect(revalidated.status).toBe(304);
    expect(calls.count).toBe(1);
  });

  test("renders without a cover when the entity has none", async () => {
    rows = {
      ...noRows,
      exhibitionBySlug: async () =>
        publishedExhibitionRow({ coverArtworkId: null, coverImageUrl: null }),
      roomIds: async () => ["room-1"],
    };
    const calls = stubImageFetch(await solidPng(600, 400));

    const res = await serveOgCard({ store, rows, slug: "wing" });

    expect(res.status).toBe(200);
    const meta = await metaOf(res);
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
    // No cover reference resolved, so no upstream fetch.
    expect(calls.count).toBe(0);
  });

  test("cover-ref present but fetch failed: serves coverless, caches nothing, retries next time", async () => {
    // Distinct per-phase IPs so the phase-1 failure's 10-minute negative cache
    // in public-image can't suppress the phase-2 retry.
    const failUrl = "https://203.0.113.20/cover.png";
    const okUrl = "https://203.0.113.21/cover.png";
    let coverUrl = failUrl;
    rows = {
      ...noRows,
      exhibitionBySlug: async () => publishedExhibitionRow(),
      roomIds: async () => ["room-1"],
      placedArtworkIds: async () => ["art-1"],
      artwork: async () => coverArtworkRow({ imageUrl: coverUrl }),
    };

    // Phase 1: the cover exists but upstream fails. A 404 aborts the fetch
    // ladder immediately (a 5xx would burn the 2s/8s backoffs).
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), {
      preconnect: realFetch.preconnect,
    });

    const failed = await serveOgCard({ store, rows, slug: "wing" });
    expect(failed.status).toBe(200);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    const failedMeta = await metaOf(failed);
    expect(failedMeta.width).toBe(1200);
    expect(failedMeta.height).toBe(630);
    const cacheFile = cardFile(uploadRoot, "exh-1");
    // A transient cover failure must not freeze a coverless card in the cache.
    expect(await Bun.file(cacheFile).exists()).toBe(false);

    // Phase 2: the cover is fetchable again, so the card caches with it.
    coverUrl = okUrl;
    const calls = stubImageFetch(await solidPng(600, 400));
    const ok = await serveOgCard({ store, rows, slug: "wing" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(calls.count).toBe(1);
    expect(await Bun.file(cacheFile).exists()).toBe(true);
  });
});

describe("serveOgCard — publish gate", () => {
  test("404s for an unpublished exhibition and writes no card", async () => {
    wireExhibition({ isPublished: false });
    const calls = stubImageFetch(await solidPng(600, 400));

    const res = await serveOgCard({ store, rows, slug: "wing" });

    expect(res.status).toBe(404);
    expect(calls.count).toBe(0);
    expect(await Bun.file(cardFile(uploadRoot, "exh-1")).exists()).toBe(false);
  });

  test("404s for a personal collection even when flagged published", async () => {
    wireExhibition({ kind: "personal", isPublished: true });
    const calls = stubImageFetch(await solidPng(600, 400));

    const res = await serveOgCard({ store, rows, slug: "wing" });

    expect(res.status).toBe(404);
    expect(calls.count).toBe(0);
  });

  test("404s for a missing exhibition", async () => {
    const res = await serveOgCard({ store, rows, slug: "nope" });
    expect(res.status).toBe(404);
  });
});

describe("deleteEntityCacheFiles — card invalidation", () => {
  test("purges the cached card so the next share re-derives it", async () => {
    wireExhibition();
    stubImageFetch(await solidPng(600, 400));

    await serveOgCard({ store, rows, slug: "wing" });
    const cacheFile = cardFile(uploadRoot, "exh-1");
    expect(await Bun.file(cacheFile).exists()).toBe(true);

    await deleteEntityCacheFiles({
      store,
      entity: "exhibition",
      id: "exh-1",
    });

    expect(await Bun.file(cacheFile).exists()).toBe(false);
  });
});
