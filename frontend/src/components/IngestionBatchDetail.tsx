import Link from "next/link";
import { ErrorNotice } from "@/components/ErrorNotice";
import { JsonDetails } from "@/components/JsonDetails";
import { EmptyState } from "@/components/tables/shared";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { ApiResult, IngestionBatchDetailResponse } from "@/lib/types";
import tableStyles from "./tables/tables.module.css";
import styles from "./IngestionBatchDetail.module.css";

type IngestionBatchDetailProps = {
  result: ApiResult<IngestionBatchDetailResponse>;
};

export function IngestionBatchDetail({ result }: IngestionBatchDetailProps) {
  if (!result.ok) {
    return (
      <section className={styles.panel}>
        <ErrorNotice result={result} />
      </section>
    );
  }

  const batch = result.data;

  return (
    <div className={styles.stack}>
      <Link className={styles.backLink} href="/ingestions">
        Back to ingestions
      </Link>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>Batch metadata</h2>
          <span className={statusClass(batch.status)}>{batch.status}</span>
        </div>
        <dl className={styles.metaGrid}>
          <MetaItem label="ID" value={String(batch.id)} />
          <MetaItem label="Provider" value={batch.provider} />
          <MetaItem label="Provider instance" value={batch.providerInstanceId || "n/a"} />
          <MetaItem label="External batch ID" value={batch.batchExternalId ?? "n/a"} />
          <MetaItem label="Ingested" value={formatDateTime(batch.ingestedAt)} />
          <MetaItem label="Received" value={formatDateTime(batch.receivedAt)} />
          <MetaItem label="Processed" value={formatDateTime(batch.processedAt)} />
          <MetaItem label="Records" value={formatNumber(batch.recordCount)} />
          {batch.errorMessage ? <MetaItem label="Error" value={batch.errorMessage} wide /> : null}
        </dl>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>Records</h2>
          <span className={styles.count}>{formatNumber(batch.records.length)}</span>
        </div>
        {batch.records.length === 0 ? (
          <EmptyState label="No records found for this batch." />
        ) : (
          <div className={tableStyles.wrapper}>
            <table className={tableStyles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Provider record</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Created</th>
                  <th>Record JSON</th>
                </tr>
              </thead>
              <tbody>
                {batch.records.map((record) => (
                  <tr key={record.id}>
                    <td>{record.id}</td>
                    <td>{record.recordType}</td>
                    <td className={tableStyles.muted}>{record.providerRecordId ?? "n/a"}</td>
                    <td className={tableStyles.muted}>{formatDateTime(record.recordStartAt)}</td>
                    <td className={tableStyles.muted}>{formatDateTime(record.recordEndAt)}</td>
                    <td className={tableStyles.muted}>{formatDateTime(record.createdAt)}</td>
                    <td>
                      {record.normalizedRecord === undefined ? (
                        <span className={tableStyles.muted}>n/a</span>
                      ) : (
                        <JsonDetails title="Normalized record" value={record.normalizedRecord} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={styles.jsonGrid}>
        <JsonDetails title="Source payload" value={batch.sourcePayload ?? null} />
        <JsonDetails title="Normalized payload" value={batch.normalizedPayload ?? null} />
      </div>
    </div>
  );
}

function MetaItem({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? styles.metaItemWide : styles.metaItem}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case "processed":
      return `${styles.status} ${styles.statusProcessed}`;
    case "failed":
      return `${styles.status} ${styles.statusFailed}`;
    default:
      return styles.status;
  }
}
