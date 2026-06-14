import { clerkClient } from "@clerk/tanstack-react-start/server";
import { createMiddleware } from "@tanstack/react-start";

/** Resolves the Clerk session from the incoming request cookie and exposes a
 * minimal `{ userId }` (or null) on the server context. Route gating only needs
 * the id — the API server independently re-validates every request. */
export const authMiddleware = createMiddleware().server(
	async ({ next, request }) => {
		const state = await clerkClient().authenticateRequest(request);
		const userId = state.isSignedIn ? state.toAuth().userId : null;
		return next({
			context: { session: userId ? { userId } : null },
		});
	},
);
