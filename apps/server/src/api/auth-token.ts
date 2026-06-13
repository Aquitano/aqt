import { createHash } from "node:crypto";
import type { auth } from "@aqt-gallery/auth";
import { db } from "@aqt-gallery/db";
import { user as userTable } from "@aqt-gallery/db/schema/auth";
import { apiToken } from "@aqt-gallery/db/schema/tokens";
import { eq } from "drizzle-orm";

/** Every personal access token starts with this so we can cheaply tell a PAT
 * apart from a better-auth bearer/session token before touching the database. */
export const API_TOKEN_PREFIX = "aqtg_";

/** A non-secret slice of the token (prefix + first chars) shown in the UI so a
 * user can recognise a token without it ever revealing the secret. */
export function tokenDisplayPrefix(token: string): string {
	return token.slice(0, API_TOKEN_PREFIX.length + 6);
}

export function hashApiToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** The exact shape better-auth's `getSession` resolves to, so a PAT-minted
 * session is a drop-in replacement at every call site. */
type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function bearerToken(headers: Headers): string | null {
	const header = headers.get("authorization");
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	const token = match?.[1]?.trim();
	return token?.startsWith(API_TOKEN_PREFIX) ? token : null;
}

/**
 * Resolve a personal access token from the request's `Authorization: Bearer`
 * header into a session-shaped object the API uses exactly like a cookie
 * session. Returns null when there's no PAT (so callers fall back to the
 * cookie session) or the token is unknown/expired.
 */
export async function sessionFromApiToken(
	headers: Headers,
): Promise<AuthSession | null> {
	const token = bearerToken(headers);
	if (!token) return null;

	const rows = await db
		.select({ token: apiToken, user: userTable })
		.from(apiToken)
		.innerJoin(userTable, eq(userTable.id, apiToken.userId))
		.where(eq(apiToken.tokenHash, hashApiToken(token)))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	if (row.token.expiresAt && row.token.expiresAt.getTime() <= Date.now()) {
		return null;
	}

	// Best-effort "last used" stamp; a write failure must never block the call.
	void (async () => {
		try {
			await db
				.update(apiToken)
				.set({ lastUsedAt: new Date() })
				.where(eq(apiToken.id, row.token.id));
		} catch {
			/* ignore — telemetry only */
		}
	})();

	const oneYearMs = 365 * 24 * 60 * 60 * 1000;
	return {
		user: row.user,
		session: {
			id: `pat:${row.token.id}`,
			token,
			userId: row.user.id,
			createdAt: row.token.createdAt,
			updatedAt: row.token.updatedAt,
			expiresAt: row.token.expiresAt ?? new Date(Date.now() + oneYearMs),
			ipAddress: null,
			userAgent: "mcp",
		},
	} as AuthSession;
}
