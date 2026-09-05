import path from "node:path";
import { getSession } from "@aqt-gallery/auth";
import { db } from "@aqt-gallery/db";
import { mediaAsset } from "@aqt-gallery/db/schema/gallery";
import { env } from "@aqt-gallery/env/server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { trpcServer } from "@hono/trpc-server";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { sessionFromApiToken } from "./api/auth-token";
import { createContext } from "./api/context";
import { appRouter } from "./api/routers/index";
import { createGalleryMcpServer } from "./mcp/server";
import { isEntity, isVariant, servePublicImage } from "./media/public-image";
import { uploadErrorResponse, uploadMedia } from "./media/upload";
import { mcpRateLimiter, uploadRateLimiter } from "./rate-limit";
import { purgeUserData, verifyClerkWebhook } from "./webhooks/clerk";

const app = new Hono();

function uploadRoot() {
  return path.resolve(env.UPLOAD_DIR);
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
  const result = await Effect.runPromise(
    uploadMedia({
      formData,
      uploadRoot: uploadRoot(),
      userId: session.user.id,
    }).pipe(
      Effect.match({
        onFailure: uploadErrorResponse,
        onSuccess: (uploaded) => ({ status: 200 as const, body: { uploaded } }),
      }),
    ),
  );

  return c.json(result.body, result.status);
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

  const filePath = variant === "thumb" ? asset.thumbnailPath : asset.storagePath;
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return c.notFound();
  }

  return new Response(file.stream(), {
    headers: {
      "Cache-Control": "private, max-age=3600",
      "Content-Type": variant === "thumb" ? "image/webp" : asset.mimeType,
    },
  });
});

// Public museum imagery, cached server-side from the stored source URLs.
app.get("/public-image/:entity/:id/:variant", async (c) => {
  const { entity, id, variant } = c.req.param();
  if (!isEntity(entity) || !isVariant(variant)) {
    return c.notFound();
  }
  return servePublicImage({
    uploadRoot: uploadRoot(),
    entity,
    id,
    variant,
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
// (galleries, artworks, media, tokens) — identities live in Clerk, so nothing
// cascades automatically and a deleted account would otherwise leave its
// published galleries publicly walkable forever.
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
      const purged = await purgeUserData(userId, uploadRoot());
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
