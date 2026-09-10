import { initTRPC, TRPCError } from "@trpc/server";

import type { Context } from "./context";

/** Opting a procedure into the MCP tool surface. A procedure without this meta
 * is invisible to agents; the tool's input schema is the procedure's own zod
 * input, so the two can never drift. */
export type McpToolMeta = {
  name: string;
  title: string;
  description: string;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
};

export type Meta = {
  mcp?: McpToolMeta;
};

export const t = initTRPC.context<Context>().meta<Meta>().create();

export const router = t.router;

/** Build a server-side caller for a router — lets the MCP endpoint invoke the
 * very same procedures the HTTP API exposes, with no logic duplication. */
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
      cause: "No session",
    });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});
