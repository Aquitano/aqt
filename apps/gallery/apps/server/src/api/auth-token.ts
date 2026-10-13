import { createHash } from "node:crypto";

import type { AuthSession } from "@aqt/gallery-auth";
import { db } from "@aqt/gallery-db";
import { apiToken } from "@aqt/gallery-db/schema/tokens";
import { and, eq, isNull, lt, or } from "drizzle-orm";

/** Every personal access token starts with this so we can cheaply tell a PAT
 * apart from a Clerk bearer/session token before touching the database. */
export const API_TOKEN_PREFIX = "aqtg_";

/** The UI shows `lastUsedAt` as a date, so refreshing it once an hour is enough. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/** A non-secret slice of the token (prefix + first chars) shown in the UI so a
 * user can recognise a token without it ever revealing the secret. */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, API_TOKEN_PREFIX.length + 6);
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token?.startsWith(API_TOKEN_PREFIX) ? token : null;
}

/**
 * Resolve a personal access token from the request's `Authorization: Bearer`
 * header into the same session shape `getSession` returns, so a PAT is a
 * drop-in replacement at every call site. Identities live in Clerk, so the
 * token row already carries the Clerk user id — no user table to join.
 * Returns null when there's no PAT (so callers fall back to the cookie
 * session) or the token is unknown/expired.
 */
export async function sessionFromApiToken(headers: Headers): Promise<AuthSession | null> {
  const token = bearerToken(headers);
  if (!token) return null;

  const rows = await db
    .select()
    .from(apiToken)
    .where(eq(apiToken.tokenHash, hashApiToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt && row.expiresAt.getTime() <= now) {
    return null;
  }

  if (!row.lastUsedAt || row.lastUsedAt.getTime() < now - LAST_USED_RESOLUTION_MS) {
    // Best-effort "last used" stamp; a write failure must never block the call.
    void (async () => {
      try {
        await db
          .update(apiToken)
          .set({ lastUsedAt: new Date(now) })
          .where(
            and(
              eq(apiToken.id, row.id),
              or(
                isNull(apiToken.lastUsedAt),
                lt(apiToken.lastUsedAt, new Date(now - LAST_USED_RESOLUTION_MS)),
              ),
            ),
          );
      } catch {
        /* ignore — telemetry only */
      }
    })();
  }

  return {
    user: { id: row.userId },
    session: { id: `pat:${row.id}`, userId: row.userId },
  };
}
