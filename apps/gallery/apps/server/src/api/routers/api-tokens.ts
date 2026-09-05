import { randomBytes } from "node:crypto";

import { db } from "@aqt/gallery-db";
import { apiToken } from "@aqt/gallery-db/schema/tokens";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { API_TOKEN_PREFIX, hashApiToken, tokenDisplayPrefix } from "../auth-token";
import { protectedProcedure, router } from "../index";

function generateToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Tokens always expire — a leaked PAT grants full account access over MCP,
 * so it should not live forever. Callers may shorten or extend within bounds. */
const DEFAULT_TOKEN_TTL_DAYS = 90;
const MAX_TOKEN_TTL_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Manage personal access tokens used to connect external agents (over MCP).
 * The plaintext token is shown exactly once, at creation; only its hash and a
 * non-secret display prefix are ever stored. */
export const apiTokensRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select({
        id: apiToken.id,
        name: apiToken.name,
        prefix: apiToken.prefix,
        lastUsedAt: apiToken.lastUsedAt,
        expiresAt: apiToken.expiresAt,
        createdAt: apiToken.createdAt,
      })
      .from(apiToken)
      .where(eq(apiToken.userId, ctx.session.user.id))
      .orderBy(desc(apiToken.createdAt));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(MAX_TOKEN_TTL_DAYS).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const token = generateToken();
      const expiresAt = new Date(
        Date.now() + (input.expiresInDays ?? DEFAULT_TOKEN_TTL_DAYS) * MS_PER_DAY,
      );
      const rows = await db
        .insert(apiToken)
        .values({
          id: crypto.randomUUID(),
          userId: ctx.session.user.id,
          name: input.name.trim(),
          tokenHash: hashApiToken(token),
          prefix: tokenDisplayPrefix(token),
          expiresAt,
        })
        .returning({
          id: apiToken.id,
          name: apiToken.name,
          prefix: apiToken.prefix,
          createdAt: apiToken.createdAt,
          expiresAt: apiToken.expiresAt,
        });
      // `token` is the only time the plaintext is ever exposed.
      return { ...rows[0], token };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await db
        .delete(apiToken)
        .where(and(eq(apiToken.id, input.id), eq(apiToken.userId, ctx.session.user.id)));
      return { ok: true };
    }),
});
