import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../index";

// Baseline: record migration 0000 as applied (its tables already exist from db:push).
const content = readFileSync("src/migrations/0000_daily_pestilence.sql", "utf8");
const hash = createHash("sha256").update(content).digest("hex");
const journal = JSON.parse(readFileSync("src/migrations/meta/_journal.json", "utf8"));
const when = journal.entries[0].when;
await db.execute(
  sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${when})`,
);
const m = await db.execute(sql`select id, created_at from drizzle.__drizzle_migrations`);
console.log("BASELINED:", JSON.stringify(m.rows));
process.exit(0);
