import path from "node:path";
import { auth } from "@aqt-gallery/auth";
import { db } from "@aqt-gallery/db";
import { mediaAsset } from "@aqt-gallery/db/schema/gallery";
import { env } from "@aqt-gallery/env/server";
import { trpcServer } from "@hono/trpc-server";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { createContext } from "./api/context";
import { appRouter } from "./api/routers/index";
import {
	isEntity,
	isVariant,
	servePublicImage,
} from "./media/public-image";
import { uploadErrorResponse, uploadMedia } from "./media/upload";

const app = new Hono();

function uploadRoot() {
	return path.resolve(env.UPLOAD_DIR);
}

async function getSession(headers: Headers) {
	return auth.api.getSession({ headers });
}

app.use(logger());
app.use(
	"/*",
	cors({
		origin: env.CORS_ORIGIN,
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	}),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.post("/media/upload", async (c) => {
	const session = await getSession(c.req.raw.headers);

	if (!session) {
		return c.json({ error: "Authentication required" }, 401);
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
	const session = await getSession(c.req.raw.headers);

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
		.where(
			and(
				eq(mediaAsset.id, c.req.param("assetId")),
				eq(mediaAsset.userId, session.user.id),
			),
		)
		.limit(1);
	const asset = rows[0];

	if (!asset) {
		return c.notFound();
	}

	const filePath =
		variant === "thumb" ? asset.thumbnailPath : asset.storagePath;
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
		// preview their own drafts without slowing the public hot path.
		resolveViewer: async () => {
			const session = await getSession(c.req.raw.headers);
			return session?.user.id;
		},
	});
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
