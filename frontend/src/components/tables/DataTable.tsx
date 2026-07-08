import type { ReactNode } from "react";
import { EmptyState } from "./shared";
import styles from "./tables.module.css";

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  muted?: boolean;
};

type Props<T> = {
  items: T[];
  columns: Column<T>[];
  emptyLabel: string;
  rowKey: (row: T) => string | number;
};

export function DataTable<T>({ items, columns, emptyLabel, rowKey }: Props<T>) {
  if (items.length === 0) return <EmptyState label={emptyLabel} />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={rowKey(item)}>
              {columns.map((column) => (
                <td key={column.header} className={column.muted ? styles.muted : undefined}>
                  {column.cell(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
