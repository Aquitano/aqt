import { getSession } from "@aqt/gallery-auth";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
  context: HonoContext;
};

export async function createContext({ context }: CreateContextOptions) {
  // The tRPC HTTP API is cookie-session only. Personal access tokens are
  // deliberately NOT honoured here — they authenticate only the agent surface
  // (/mcp, /media/upload, owner preview on /public-image), so a leaked agent
  // token can't reach token management or any other procedure outside it.
  const session = await getSession(context.req.raw);
  return {
    auth: null,
    session,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
