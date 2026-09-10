import path from "node:path";

import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), "apps/server/.env") });

// In test environments or when running unit tests without env files,
// provide placeholder defaults so validation succeeds.
if (process.env.NODE_ENV === "test") {
  process.env.DATABASE_URL ??= "postgres://ci:ci@localhost:5432/ci";
  process.env.CLERK_SECRET_KEY ??= "sk_test_ci_placeholder_not_used";
  process.env.CLERK_PUBLISHABLE_KEY ??= "pk_test_ci_placeholder_not_used";
  process.env.SERVER_URL ??= "http://localhost:3000";
  process.env.CORS_ORIGIN ??= "http://localhost:3001";
}

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
    // Where media lives when no S3 bucket is configured (development, tests).
    UPLOAD_DIR: z.string().min(1).default("./uploads"),
    // S3-compatible object storage for all media. Set all four or none; with
    // none, media falls back to UPLOAD_DIR on local disk.
    S3_BUCKET: z.string().min(1).optional(),
    // Cloudflare R2: https://<accountId>.r2.cloudflarestorage.com
    S3_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    // R2 has a single region and wants the literal "auto".
    S3_REGION: z.string().min(1).default("auto"),
    // Number of trusted proxy hops in front of this server. The public-image
    // rate limiter reads the client IP this many entries from the right of
    // X-Forwarded-For — the leftmost entries are client-supplied and spoofable.
    // Must match the real topology: too low keys on a spoofable address, too
    // high collapses every client onto one shared (intermediate-proxy) bucket.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).default(1),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  },
  // A half-configured bucket is worse than none: the server would boot and then
  // fail every media read against storage it can't authenticate to.
  createFinalSchema: (shape) =>
    z.object(shape).refine(
      (vars) => {
        const s3 = [
          vars.S3_BUCKET,
          vars.S3_ENDPOINT,
          vars.S3_ACCESS_KEY_ID,
          vars.S3_SECRET_ACCESS_KEY,
        ];
        return s3.every((v) => v === undefined) || s3.every((v) => v !== undefined);
      },
      {
        message:
          "Set all of S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or none of them",
      },
    ),
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
