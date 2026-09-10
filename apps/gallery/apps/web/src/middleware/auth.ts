import { clerkClient } from "@clerk/tanstack-react-start/server";
import { createMiddleware } from "@tanstack/react-start";

/** Resolves the Clerk session from the incoming request cookie and exposes a
 * minimal `{ userId }` (or null) on the server context. Route gating only needs
 * the id — the API server independently re-validates every request. */
export const authMiddleware = createMiddleware().server(
	async ({ next, request }) => {
		// Treat a thrown Clerk error (transient network/outage/misconfig) as an
		// unauthenticated session rather than letting it propagate — otherwise a
		// Clerk hiccup takes down even public routes (the landing page) instead of
		// degrading to logged-out. Protected routes still redirect on a null
		// session, so they keep failing closed.
		let userId: string | null = null;
		try {
			const state = await clerkClient().authenticateRequest(request);
			userId = state.isSignedIn ? state.toAuth().userId : null;
		} catch {
			userId = null;
		}
		return next({
			context: { session: userId ? { userId } : null },
		});
	},
);
