import { auth } from "@aqt-gallery/auth";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
	context: HonoContext;
};

export async function createContext({ context }: CreateContextOptions) {
	// The tRPC HTTP API is cookie-session only. Personal access tokens are
	// deliberately NOT honoured here — they authenticate the /mcp endpoint
	// alone, so a leaked agent token can't reach token management or any other
	// procedure outside the MCP tool surface.
	const session = await auth.api.getSession({
		headers: context.req.raw.headers,
	});
	return {
		auth: null,
		session,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
