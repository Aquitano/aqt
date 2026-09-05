import { and, desc, eq, lt, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/server/db/client";
import { apiKeys } from "@/server/db/schema";

const KEY_PREFIX = "alb_";
/** Characters of the key kept in clear for display, prefix included. */
const VISIBLE = 10;
/** How stale `lastUsedAt` may get before a request refreshes it. */
const USED_AT_RESOLUTION = 60 * 60 * 1000;

async function sha256(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Public shape: everything except the hash. */
const publicColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
};

export function listApiKeys(ownerId: string) {
  return db()
    .select(publicColumns)
    .from(apiKeys)
    .where(eq(apiKeys.ownerId, ownerId))
    .orderBy(desc(apiKeys.createdAt));
}

/** Returns the plaintext key exactly once; only its hash is stored. */
export async function createApiKey(ownerId: string, name: string) {
  const key = KEY_PREFIX + nanoid(32);
  const row = {
    id: nanoid(12),
    ownerId,
    name,
    hash: await sha256(key),
    prefix: key.slice(0, VISIBLE),
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  await db().insert(apiKeys).values(row);
  const { hash: _hash, ...rest } = row;
  return { key, ...rest };
}

export async function revokeApiKey(id: string, ownerId: string) {
  const result = await db()
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId)));
  if (result.meta.changes === 0) throw new Response("Not found", { status: 404 });
}

/** The owner of a bearer key, or null when it is unknown. */
export async function userIdForApiKey(key: string) {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const hash = await sha256(key);
  const [row] = await db()
    .select({ id: apiKeys.id, ownerId: apiKeys.ownerId })
    .from(apiKeys)
    .where(eq(apiKeys.hash, hash));
  if (!row) return null;
  const now = Date.now();
  await db()
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, now - USED_AT_RESOLUTION)),
      ),
    );
  return row.ownerId;
}
