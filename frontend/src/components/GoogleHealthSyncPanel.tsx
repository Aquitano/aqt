"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState, useTransition } from "react";
import type { ApiResult, GoogleHealthSyncResponse } from "@/lib/types";

const dataTypeOptions = [
  { label: "Steps", value: "steps" },
  { label: "Sleep", value: "sleep" },
  { label: "Heart rate", value: "heart-rate" },
  { label: "Weight", value: "weight" },
  { label: "Body fat", value: "body-fat" },
];

export function GoogleHealthSyncPanel() {
  const router = useRouter();
  const [result, setResult] = useState<ApiResult<GoogleHealthSyncResponse> | null>(null);
  const [isPending, startTransition] = useTransition();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);

    const formData = new FormData(event.currentTarget);
    const payload = {
      from: toIso(formData.get("from")),
      to: toIso(formData.get("to")),
      dataTypes: formData.getAll("dataTypes").map(String),
      pageSize: toPositiveInteger(formData.get("pageSize")),
    };

    startTransition(async () => {
      const response = await fetch("/api/google-health/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as ApiResult<GoogleHealthSyncResponse>;
      setResult(body);
      if (body.ok) router.refresh();
    });
  }

  return (
    <section className="data-section sync-panel">
      <div className="section-heading">
        <h2>Google Health sync</h2>
      </div>
      <form className="sync-form" onSubmit={onSubmit}>
        <label>
          <span>From</span>
          <input name="from" type="datetime-local" />
        </label>
        <label>
          <span>To</span>
          <input name="to" type="datetime-local" />
        </label>
        <label>
          <span>Page size</span>
          <input name="pageSize" type="number" min="1" max="5000" placeholder="default" />
        </label>
        <fieldset>
          <legend>Data types</legend>
          <div className="checkbox-row">
            {dataTypeOptions.map((option) => (
              <label key={option.value}>
                <input name="dataTypes" type="checkbox" value={option.value} defaultChecked />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={isPending}>
          {isPending ? "Syncing..." : "Start sync"}
        </button>
      </form>
      {result ? <SyncResult result={result} /> : null}
    </section>
  );
}

function SyncResult({ result }: { result: ApiResult<GoogleHealthSyncResponse> }) {
  if (!result.ok) {
    return (
      <div className="notice error">
        {result.status ? <strong>HTTP {result.status}: </strong> : null}
        {result.message}
      </div>
    );
  }

  const created = result.data.batches.reduce(
    (sum, batch) =>
      sum +
      batch.metricsCreated.stepSamples +
      batch.metricsCreated.sleepSessions +
      batch.metricsCreated.bodyMeasurements +
      batch.metricsCreated.heartRateSamples,
    0,
  );

  return (
    <div className="sync-result">
      <strong>
        Synced {result.data.batches.length} batches, created {created} metrics
      </strong>
      <span>
        {result.data.requestedRange.from} to {result.data.requestedRange.to}
      </span>
      {result.data.errors.length > 0 ? (
        <ul>
          {result.data.errors.map((error) => (
            <li key={`${error.dataType}-${error.code}`}>
              {error.dataType}: {error.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function toIso(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function toPositiveInteger(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
