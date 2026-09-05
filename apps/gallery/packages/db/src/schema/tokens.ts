import {
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
};

/**
 * Personal access tokens that let an external agent (e.g. over MCP) act on
 * behalf of a user. Only the SHA-256 hash of the token is stored — the
 * plaintext is shown exactly once, at creation. `prefix` is a non-secret
 * display hint (e.g. "aqtg_a1b2…") so a user can recognise a token in the
 * list without it ever revealing the secret. A null `expiresAt` never expires.
 */
export const apiToken = pgTable(
	"api_token",
	{
		id: text("id").primaryKey(),
		// Clerk user id of the token owner. No FK (identities live in Clerk).
		userId: text("user_id").notNull(),
		name: text("name").notNull(),
		tokenHash: text("token_hash").notNull(),
		prefix: text("prefix").notNull(),
		lastUsedAt: timestamp("last_used_at"),
		expiresAt: timestamp("expires_at"),
		...timestamps,
	},
	(table) => [
		index("api_token_user_id_idx").on(table.userId),
		uniqueIndex("api_token_hash_idx").on(table.tokenHash),
	],
);
