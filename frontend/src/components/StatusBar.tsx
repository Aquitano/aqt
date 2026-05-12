import { formatDateTime } from "@/lib/format";
import type { ApiResult, HealthResponse } from "@/lib/types";

type StatusBarProps = {
  apiBaseUrl: string;
  health: ApiResult<HealthResponse>;
  fromDate: string;
  toDate: string;
};

export function StatusBar({ apiBaseUrl, health, fromDate, toDate }: StatusBarProps) {
  const status = health.ok ? health.data.status : "offline";
  const serviceTime = health.ok ? formatDateTime(health.data.time) : "n/a";

  return (
    <section className="status-bar" aria-label="Backend status">
      <div>
        <span className={`status-dot ${health.ok ? "ok" : "bad"}`} aria-hidden="true" />
        <strong>{status}</strong>
      </div>
      <div>
        <span>API</span>
        <strong>{apiBaseUrl}</strong>
      </div>
      <div>
        <span>Range</span>
        <strong>
          {fromDate} to {toDate}
        </strong>
      </div>
      <div>
        <span>Backend time</span>
        <strong>{serviceTime}</strong>
      </div>
    </section>
  );
}
