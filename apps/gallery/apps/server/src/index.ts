import { getSession } from "@aqt/gallery-auth";
import { db } from "@aqt/gallery-db";
import { mediaAsset } from "@aqt/gallery-db/schema/gallery";
import { env } from "@aqt/gallery-env/server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { trpcServer } from "@hono/trpc-server";
import { and, eq } from "drizzle-orm";
import type { Context as HonoContext } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { beaconBatchSchema, recordBeaconEvents } from "./analytics/beacon";
import { sessionFromApiToken } from "./api/auth-token";
import { createContext } from "./api/context";
import { appRouter } from "./api/routers/index";
import { createGalleryMcpServer } from "./mcp/server";
import { serveOgCard } from "./media/og-card";
import { mediaKey } from "./media/paths";
import { isEntity, isVariant, servePublicImage, warmArtworkImages } from "./media/public-image";
import { mediaStore } from "./media/store";
import { uploadErrorResponse, uploadMedia } from "./media/upload";
import {
  mcpRateLimiter,
  publicImageRateLimiter,
  statsBeaconRateLimiter,
  uploadRateLimiter,
} from "./rate-limit";
import { purgeUserData, verifyClerkWebhook } from "./webhooks/clerk";

const app = new Hono();

/** Rate-limit key for an anonymous request: the client IP TRUSTED_PROXY_HOPS
 * entries from the right of X-Forwarded-For — the address our own trusted proxy
 * chain appended. Entries further left are client-supplied and trivially
 * spoofed, which would let one client land every request in a fresh bucket and
 * bypass the limiter. Picking a fixed offset from the right (not
 * unconditionally the last entry) keeps the real client IP as the key through
 * multiple trusted hops; the last entry then would be an intermediate proxy
 * shared by every client. Fall back to a shared bucket when the header is
 * missing/short so direct hits stay bounded. */
function anonymousRateKey(c: HonoContext): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  const parts =
    forwardedFor
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  return parts[parts.length - env.TRUSTED_PROXY_HOPS] || "anon";
}

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      // Headers the MCP Streamable HTTP transport sends.
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-ID",
    ],
    exposeHeaders: ["Mcp-Session-Id"],
    credentials: true,
  }),
);

app.post("/media/upload", async (c) => {
  const session = await getSession(c.req.raw);

  if (!session) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const limit = uploadRateLimiter.check(session.user.id);
  if (!limit.ok) {
    return c.json({ error: "Too many uploads — try again shortly" }, 429, {
      "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  }

  const formData = await c.req.formData();
  const result = await uploadMedia({
    formData,
    store: mediaStore,
    userId: session.user.id,
  });
  if (!result.ok) {
    const { status, body } = uploadErrorResponse(result.error);
    return c.json(body, status);
  }

  void warmArtworkImages({
    store: mediaStore,
    ownerId: session.user.id,
    artworkIds: result.uploaded.map((u) => u.artworkId),
  });

  return c.json({ uploaded: result.uploaded }, 200);
});

app.get("/media/:assetId/:variant", async (c) => {
  const session = await getSession(c.req.raw);

  if (!session) {
    return c.notFound();
  }

  const variant = c.req.param("variant");

  if (variant !== "original" && variant !== "thumb") {
    return c.notFound();
  }

  const rows = await db
    .select()
    .from(mediaAsset)
    .where(and(eq(mediaAsset.id, c.req.param("assetId")), eq(mediaAsset.userId, session.user.id)))
    .limit(1);
  const asset = rows[0];

  if (!asset) {
    return c.notFound();
  }

  const object = await mediaStore.get(
    mediaKey(variant === "thumb" ? asset.thumbnailPath : asset.storagePath),
  );

  if (!object) {
    return c.notFound();
  }

  return new Response(object.stream, {
    headers: {
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(object.size),
      "Content-Type": variant === "thumb" ? "image/webp" : asset.mimeType,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// Public exhibition imagery, cached server-side from the stored source URLs.
app.get("/public-image/:entity/:id/:variant", async (c) => {
  const { entity, id, variant } = c.req.param();
  if (!isEntity(entity) || !isVariant(variant)) {
    return c.notFound();
  }
  const clientKey = anonymousRateKey(c);
  return servePublicImage({
    store: mediaStore,
    entity,
    id,
    variant,
    ifNoneMatch: c.req.header("if-none-match"),
    checkUpstreamBudget: () => publicImageRateLimiter.check(clientKey),
    // Resolved lazily (only for unpublished artworks) so an owner can
    // preview their own drafts without slowing the public hot path — via a
    // browser cookie or a personal access token, so an agent can fetch the
    // bytes of the artworks it just imported.
    resolveViewer: async () => {
      const session =
        (await sessionFromApiToken(c.req.raw.headers)) ?? (await getSession(c.req.raw));
      return session?.user.id;
    },
  });
});

// Auto-generated social-share card (Open Graph / Twitter) for a published
// exhibition. Keyed by the public slug so the web routes can build the
// og:image URL without knowing the entity id. Unpublished/missing/personal
// entities 404 (no owner preview — a draft has no shareable link yet).
app.get("/og-image/:slug", async (c) => {
  const clientKey = anonymousRateKey(c);
  return serveOgCard({
    store: mediaStore,
    slug: c.req.param("slug"),
    ifNoneMatch: c.req.header("if-none-match"),
    // Only consulted on a cover cache miss (rare — the lobby/museum page has
    // usually warmed it); cached cards and cover hits never hit a third party.
    checkUpstreamBudget: () => publicImageRateLimiter.check(clientKey),
  });
});

// Anonymous visit-stats beacon. No auth, no cookies, no identity: the public
// walkthrough batches a few {entityKind, entityId, metric} events and flushes
// them here (navigator.sendBeacon on page hide, plus a size threshold). Only
// aggregate day counters are written, and only for published entities.
// Rate-limited by client IP and counted in events. Always answers 204 — invalid
// or over-budget batches are silently dropped so the endpoint never signals
// whether an entity exists.
app.post(
  "/beacon/stats",
  // Reject oversized bodies before we parse: 50 small events fit well under
  // 16 KB, so anything larger is abuse and must not reach c.req.json(). Kept
  // silent (204) to match the endpoint never signalling anything.
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.body(null, 204) }),
  async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.body(null, 204);
    }

    const parsed = beaconBatchSchema.safeParse(payload);
    if (!parsed.success) {
      return c.body(null, 204);
    }

    const limit = statsBeaconRateLimiter.check(anonymousRateKey(c), parsed.data.events.length);
    if (!limit.ok) {
      return c.body(null, 204);
    }

    try {
      await recordBeaconEvents(parsed.data.events);
    } catch (err) {
      console.error("failed to record visit beacon", err);
    }
    return c.body(null, 204);
  },
);

// Model Context Protocol endpoint — lets an external agent drive the gallery
// (import, enrich, curate, publish) on behalf of a user. Authenticated by a
// personal access token (Authorization: Bearer aqtg_…) or a browser cookie
// session. Stateless: a fresh server + transport handle each request. Only
// POST (JSON-RPC) and DELETE (teardown) are served — a stateless server has no
// use for the GET server→client SSE stream.
app.on(["POST", "DELETE"], "/mcp", async (c) => {
  const headers = c.req.raw.headers;
  const session = (await sessionFromApiToken(headers)) ?? (await getSession(c.req.raw));

  if (!session) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Authentication required" },
        id: null,
      },
      401,
    );
  }

  const limit = mcpRateLimiter.check(session.user.id);
  if (!limit.ok) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32029, message: "Rate limit exceeded" },
        id: null,
      },
      429,
      { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
    );
  }

  const server = createGalleryMcpServer(session);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.body(null, 204);
});

// Clerk account-lifecycle webhook. On user.deleted we purge that user's data
// (exhibitions, artworks, media, tokens) — identities live in Clerk, so nothing
// cascades automatically and a deleted account would otherwise leave its
// published exhibitions publicly walkable forever.
app.post("/webhooks/clerk", async (c) => {
  const secret = env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    console.warn("Clerk webhook hit but CLERK_WEBHOOK_SIGNING_SECRET is not set — ignoring");
    return c.json({ error: "Webhook not configured" }, 503);
  }

  const body = await c.req.text();
  const verified = verifyClerkWebhook(
    secret,
    {
      id: c.req.header("svix-id"),
      timestamp: c.req.header("svix-timestamp"),
      signature: c.req.header("svix-signature"),
    },
    body,
  );
  if (!verified) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let event: { type?: string; data?: { id?: unknown } };
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }

  if (event.type === "user.deleted") {
    const userId = event.data?.id;
    if (typeof userId === "string" && userId) {
      const purged = await purgeUserData(userId, mediaStore);
      console.log(`Purged data for deleted Clerk user ${userId}`, purged);
    }
  }

  return c.json({ ok: true });
});

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

export default {
  fetch: app.fetch,
  /** Cold museum loads proxy many images upstream at once; Bun's default
   * 10s idle timeout drops those requests mid-queue (ERR_EMPTY_RESPONSE). */
  idleTimeout: 60,
};
