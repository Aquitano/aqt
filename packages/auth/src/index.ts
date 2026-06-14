import { env } from "@aqt-gallery/env/server";
import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
	secretKey: env.CLERK_SECRET_KEY,
	publishableKey: env.CLERK_PUBLISHABLE_KEY,
});

/**
 * The session shape the API acts on. Identities live in Clerk, not in this
 * database, so a session is just the Clerk user id (plus the session id for
 * logging). Personal-access-token auth mints the same shape, so a PAT is a
 * drop-in replacement at every call site (see apps/server/src/api/auth-token).
 */
export type AuthSession = {
	user: { id: string };
	session: { id: string; userId: string };
};

/**
 * Resolve the Clerk session from a request's `__session` cookie (or a Clerk
 * bearer token). Networkless JWT verification — no round-trip to Clerk on the
 * hot path. Returns null when the request is unauthenticated.
 */
export async function getSession(
	request: Request,
): Promise<AuthSession | null> {
	const state = await clerk.authenticateRequest(request, {
		// Only accept tokens minted for our own web origin.
		authorizedParties: [env.CORS_ORIGIN],
	});

	if (!state.isSignedIn) return null;

	const { userId, sessionId } = state.toAuth();
	if (!userId) return null;

	return {
		user: { id: userId },
		session: { id: sessionId ?? userId, userId },
	};
}
