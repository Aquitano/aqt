import { sql } from "drizzle-orm";

import { db } from "../index";

const rows = await db.execute(
  sql`select table_name from information_schema.tables where table_schema='public' order by table_name`,
);
console.log(rows.rows.map((r: any) => r.table_name).join(", "));
const cols = await db.execute(
  sql`select column_name from information_schema.columns where table_name='artwork' order by column_name`,
);
console.log("ARTWORK:", cols.rows.map((r: any) => r.column_name).join(", "));
process.exit(0);
