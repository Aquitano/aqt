import { sql } from "drizzle-orm";

import { db } from "../index";

const j = await db.execute(
  sql`select table_schema, table_name from information_schema.tables where table_name like '%drizzle%'`,
);
console.log("JOURNAL TABLES:", JSON.stringify(j.rows));
try {
  const m = await db.execute(
    sql`select id, hash, created_at from drizzle.__drizzle_migrations order by created_at`,
  );
  console.log("APPLIED:", JSON.stringify(m.rows));
} catch (e: any) {
  console.log("NO JOURNAL:", e.message);
}
process.exit(0);
