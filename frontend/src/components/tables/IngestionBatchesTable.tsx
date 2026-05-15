import { formatDateTime, formatNumber } from "@/lib/format";
import type { IngestionBatch } from "@/lib/types";
import { EmptyState } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: IngestionBatch[];
};

function badgeClass(status: string): string {
  switch (status) {
    case "processed":
      return `${styles.badge} ${styles.badgeProcessed}`;
    case "failed":
      return `${styles.badge} ${styles.badgeFailed}`;
    default:
      return `${styles.badge} ${styles.badgeDefault}`;
  }
}

export function IngestionBatchesTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No ingestion batches found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Provider</th>
            <th>Records</th>
            <th>Ingested</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.id}</td>
              <td>
                <span className={badgeClass(item.status)}>{item.status}</span>
              </td>
              <td className={styles.muted}>{item.providerInstanceId || item.provider}</td>
              <td>{formatNumber(item.recordCount)}</td>
              <td className={styles.muted}>{formatDateTime(item.ingestedAt)}</td>
              <td className={styles.muted}>{item.errorMessage ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
