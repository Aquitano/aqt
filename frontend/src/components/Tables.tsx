import { formatDateTime, formatDuration, formatMeasurement, formatNumber } from "@/lib/format";
import type {
  BodyMeasurement,
  HeartRateSample,
  IngestionBatch,
  SleepSession,
  StepDailySummary,
} from "@/lib/types";

type TableProps<T> = {
  items: T[];
};

export function DailyStepsTable({ items }: TableProps<StepDailySummary>) {
  if (items.length === 0) return <EmptyState label="No daily step summaries found." />;

  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Steps</th>
          <th>Samples</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={`${item.date}-${item.source?.providerInstanceId ?? "all"}`}>
            <td>{item.date}</td>
            <td>{formatNumber(item.steps)}</td>
            <td>{formatNumber(item.sampleCount)}</td>
            <td>{sourceLabel(item.source)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BodyMeasurementsTable({ items }: TableProps<BodyMeasurement>) {
  if (items.length === 0) return <EmptyState label="No body measurements found." />;

  return (
    <table>
      <thead>
        <tr>
          <th>Measured</th>
          <th>Metric</th>
          <th>Value</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{formatDateTime(item.measuredAt)}</td>
            <td>{item.metricType}</td>
            <td>{formatMeasurement(item.value, item.unit)}</td>
            <td>{sourceLabel(item.source)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HeartRateTable({ items }: TableProps<HeartRateSample>) {
  if (items.length === 0) return <EmptyState label="No heart-rate samples found." />;

  return (
    <table>
      <thead>
        <tr>
          <th>Measured</th>
          <th>BPM</th>
          <th>Context</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{formatDateTime(item.measuredAt)}</td>
            <td>{item.bpm}</td>
            <td>{item.context}</td>
            <td>{sourceLabel(item.source)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SleepSessionsTable({ items }: TableProps<SleepSession>) {
  if (items.length === 0) return <EmptyState label="No sleep sessions found." />;

  return (
    <table>
      <thead>
        <tr>
          <th>Start</th>
          <th>End</th>
          <th>Duration</th>
          <th>Stages</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{formatDateTime(item.startAt)}</td>
            <td>{formatDateTime(item.endAt)}</td>
            <td>{formatDuration(item.durationSeconds)}</td>
            <td>{item.stages.map((stage) => stage.stage).join(", ") || "n/a"}</td>
            <td>{sourceLabel(item.source)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IngestionBatchesTable({ items }: TableProps<IngestionBatch>) {
  if (items.length === 0) return <EmptyState label="No ingestion batches found." />;

  return (
    <table>
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
              <span className={`badge ${item.status}`}>{item.status}</span>
            </td>
            <td>{item.providerInstanceId || item.provider}</td>
            <td>{formatNumber(item.recordCount)}</td>
            <td>{formatDateTime(item.ingestedAt)}</td>
            <td>{item.errorMessage ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="empty-state">{label}</p>;
}

function sourceLabel(source?: { provider: string; providerInstanceId: string }): string {
  if (!source) return "n/a";
  return `${source.provider} / ${source.providerInstanceId}`;
}
