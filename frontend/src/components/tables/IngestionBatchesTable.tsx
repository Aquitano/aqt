import Link from "next/link";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { IngestionBatch } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import styles from "./tables.module.css";

type Props = {
  items: IngestionBatch[];
  getHref?: (item: IngestionBatch) => string;
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

export function IngestionBatchesTable({ items, getHref }: Props) {
  const columns: Column<IngestionBatch>[] = [
    { header: "ID", cell: (item) => (getHref ? <Link href={getHref(item)}>{item.id}</Link> : item.id) },
    { header: "Status", cell: (item) => <span className={badgeClass(item.status)}>{item.status}</span> },
    { header: "Provider", cell: (item) => item.providerInstanceId || item.provider, muted: true },
    { header: "Records", cell: (item) => formatNumber(item.recordCount) },
    { header: "Ingested", cell: (item) => formatDateTime(item.ingestedAt), muted: true },
    { header: "Error", cell: (item) => item.errorMessage ?? "", muted: true },
  ];

  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No ingestion batches found."
      rowKey={(item) => item.id}
    />
  );
}
