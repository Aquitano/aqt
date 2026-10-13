import { type Column, getTableColumns, type SQL, sql, type Table } from "drizzle-orm";

type ColumnKey<T extends Table> = keyof T["_"]["columns"] & string;

// One bind parameter regardless of archive size. JSON encoding preserves quotes and backslashes
// without depending on the driver's PostgreSQL array serializer.
export const textValues = (values: ReadonlyArray<string>): SQL =>
  sql`SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)`;

export const uuidValues = (values: ReadonlyArray<string>): SQL =>
  sql`SELECT value::uuid FROM (${textValues(values)}) AS ids(value)`;

const column = <T extends Table>(table: T, key: ColumnKey<T>): Column => {
  const found: Column | undefined = getTableColumns(table)[key];
  if (found === undefined) throw new Error(`unknown column ${key}`);
  return found;
};

const excludedColumn = <T extends Table>(table: T, key: ColumnKey<T>): SQL =>
  sql`excluded.${sql.identifier(column(table, key).name)}`;

export const excluded = <T extends Table, K extends ColumnKey<T>>(
  table: T,
  keys: ReadonlyArray<K>,
): Record<K, SQL> =>
  // SAFETY: the entries are built from exactly the keys in K, one property per key.
  Object.fromEntries(keys.map((key) => [key, excludedColumn(table, key)])) as Record<K, SQL>;

export const differsFromExcluded = <T extends Table>(
  table: T,
  keys: ReadonlyArray<ColumnKey<T>>,
): SQL =>
  sql.join(
    keys.map((key) => sql`${column(table, key)} IS DISTINCT FROM ${excludedColumn(table, key)}`),
    sql` OR `,
  );
