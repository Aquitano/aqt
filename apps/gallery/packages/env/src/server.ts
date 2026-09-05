import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		DATABASE_URL: z.string().min(1),
		CLERK_SECRET_KEY: z.string().min(1),
		CLERK_PUBLISHABLE_KEY: z.string().min(1),
		// Signing secret (whsec_…) for the Clerk webhook that purges a user's
		// data when their account is deleted. Optional so local/dev runs without
		// it still boot; the webhook returns 503 until it's configured.
		CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
		// This server's own public origin, used to build absolute image URLs an
		// agent can fetch (previously BETTER_AUTH_URL).
		SERVER_URL: z.url(),
		CORS_ORIGIN: z.url(),
		UPLOAD_DIR: z.string().min(1).default("./uploads"),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
