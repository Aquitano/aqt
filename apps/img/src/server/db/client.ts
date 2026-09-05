import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema";

/** Bindings are only reachable inside a request, so the client is built per call. */
export function db() {
  return drizzle(env.DB, { schema });
}
