import { env } from "@aqt/gallery-env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export function createDb(): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(env.DATABASE_URL, { schema });
}

export const db: ReturnType<typeof createDb> = createDb();
