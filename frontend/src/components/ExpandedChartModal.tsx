"use client";

import { X } from "lucide-react";
import { useEffect, useId } from "react";
import {
  HealthChartDatum,
  HealthChartSeries,
  HealthMetricChart,
  type ChartPointDetail,
} from "@/components/charts/HealthMetricChart";
import styles from "./ExpandedChartModal.module.css";

export type ChartSummary = {
  label: string;
  value: string;
};

type ExpandedChartModalProps = {
  title: string;
  description?: string;
  series: HealthChartSeries[];
  data: HealthChartDatum[];
  defaultVisibleMetricKeys: string[];
  summaries: ChartSummary[];
  details: ChartPointDetail[];
  onClose: () => void;
};

export function ExpandedChartModal({
  title,
  description,
  series,
  data,
  defaultVisibleMetricKeys,
  summaries,
  details,
  onClose,
}: ExpandedChartModalProps) {
  const titleId = useId();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onBackdropMouseDown}>
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close expanded chart">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {summaries.length ? (
          <dl className={styles.summaries}>
            {summaries.map((summary) => (
              <div className={styles.summaryItem} key={summary.label}>
                <dt>{summary.label}</dt>
                <dd>{summary.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className={styles.chartWrap}>
          <HealthMetricChart
            title={title}
            description={description}
            series={series}
            data={data}
            defaultVisibleMetricKeys={defaultVisibleMetricKeys}
            height="clamp(260px, 42vh, 460px)"
          />
        </div>

        <div className={styles.detailTableWrap}>
          {details.length ? (
            <table className={styles.detailTable}>
              <thead>
                <tr>
                  <th>Measured</th>
                  <th>Metric</th>
                  <th>Value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {details.map((detail) => (
                  <tr key={detail.id}>
                    <td>{formatDateTime(detail.at)}</td>
                    <td>{detail.label}</td>
                    <td>{formatValue(detail.value, detail.unit)}</td>
                    <td>{detail.source ?? "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={styles.empty}>No detailed points available.</p>
          )}
        </div>
      </section>
    </div>
  );

  function onBackdropMouseDown() {
    onClose();
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatValue(value: number, unit?: string): string {
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}
