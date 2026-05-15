"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  ApiResult,
  ProviderCatalogResponse,
  ProviderDescriptor,
  ProviderOAuthStartResponse,
  ProviderStatus,
  ProviderStatusCatalogResponse,
  ProviderSyncResponse,
} from "@/lib/types";
import styles from "./ProviderSyncPanel.module.css";

type ProviderSyncPanelProps = {
  catalog: ApiResult<ProviderCatalogResponse>;
  statuses: ApiResult<ProviderStatusCatalogResponse>;
};

type ProviderOption = {
  descriptor: ProviderDescriptor;
  status?: ProviderStatus;
};

export function ProviderSyncPanel({ catalog, statuses }: ProviderSyncPanelProps) {
  const router = useRouter();
  const [selectedProviderCode, setSelectedProviderCode] = useState("");
  const [result, setResult] = useState<ApiResult<ProviderSyncResponse> | null>(null);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isOAuthPending, startOAuthTransition] = useTransition();

  if (!catalog.ok || !statuses.ok) {
    return (
      <section className={styles.panel}>
        <div className={styles.heading}>
          <h2>Provider sync</h2>
        </div>
        {!catalog.ok ? <ErrorBlock result={catalog} /> : null}
        {!statuses.ok ? <ErrorBlock result={statuses} /> : null}
      </section>
    );
  }

  const providers = catalog.data.providers.map((descriptor) => ({
    descriptor,
    status: statuses.data.providers.find((status) => status.providerCode === descriptor.providerCode),
  }));
  const selectedProvider =
    providers.find((provider) => provider.descriptor.providerCode === selectedProviderCode) ??
    providers[0];
  const canSync = Boolean(selectedProvider?.status?.canSync);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProvider || !canSync) return;
    setResult(null);

    const formData = new FormData(event.currentTarget);
    const payload = {
      from: toIso(formData.get("from")),
      to: toIso(formData.get("to")),
      dataTypes: selectedDataTypes(formData),
      pageSize: selectedProvider.descriptor.supportsPageSize
        ? toPositiveInteger(formData.get("pageSize"))
        : undefined,
    };

    startTransition(async () => {
      const response = await fetch(
        `/api/providers/${encodeURIComponent(selectedProvider.descriptor.providerCode)}/sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json()) as ApiResult<ProviderSyncResponse>;
      setResult(body);
      if (body.ok) router.refresh();
    });
  }

  function onStartOAuth() {
    if (!selectedProvider?.descriptor.workflowEndpoints.oauthStart) return;
    setResult(null);
    setOAuthError(null);

    startOAuthTransition(async () => {
      const response = await fetch(
        `/api/providers/${encodeURIComponent(selectedProvider.descriptor.providerCode)}/oauth/start`,
        { method: "POST" },
      );
      const body = (await response.json()) as ApiResult<ProviderOAuthStartResponse>;
      if (body.ok) {
        window.location.assign(body.data.authorizationUrl);
      } else {
        setOAuthError(body.message);
      }
    });
  }

  return (
    <section className={styles.panel}>
      <div className={styles.heading}>
        <h2>Provider sync</h2>
        {selectedProvider?.status ? (
          <span className={styles.statusPill}>{selectedProvider.status.nextAction}</span>
        ) : null}
      </div>

      <div className={styles.providerTabs}>
        {providers.map((provider) => (
          <button
            className={provider === selectedProvider ? styles.providerTabActive : styles.providerTab}
            key={provider.descriptor.providerCode}
            onClick={() => {
              setResult(null);
              setSelectedProviderCode(provider.descriptor.providerCode);
            }}
            type="button"
          >
            <span>{provider.descriptor.displayName}</span>
            <small>{provider.status?.nextAction ?? "unknown"}</small>
          </button>
        ))}
      </div>

      {selectedProvider ? (
        <ProviderStatusSummary
          isOAuthPending={isOAuthPending}
          oauthError={oauthError}
          onStartOAuth={onStartOAuth}
          provider={selectedProvider}
        />
      ) : null}

      {selectedProvider ? (
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>From</span>
            <input className={styles.input} name="from" type="datetime-local" />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>To</span>
            <input className={styles.input} name="to" type="datetime-local" />
          </div>
          {selectedProvider.descriptor.supportsPageSize ? (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Page size</span>
              <input
                className={styles.input}
                name="pageSize"
                type="number"
                min="1"
                max="5000"
                placeholder="default"
              />
            </div>
          ) : null}
          <fieldset className={styles.fieldset} key={selectedProvider.descriptor.providerCode}>
            <legend className={styles.legend}>Data types</legend>
            <div className={styles.checkboxRow}>
              {selectedProvider.descriptor.supportedDataTypes.map((dataType) => (
                <label className={styles.checkboxLabel} key={dataType}>
                  <input
                    defaultChecked={selectedProvider.descriptor.defaultDataTypes.includes(dataType)}
                    name="dataTypes"
                    type="checkbox"
                    value={dataType}
                  />
                  <span>{formatDataType(dataType)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button className={styles.submit} type="submit" disabled={isPending || !canSync}>
            {isPending ? (
              <>
                <span className={styles.spinner} />
                Syncing...
              </>
            ) : (
              "Start sync"
            )}
          </button>
        </form>
      ) : null}

      {result ? <SyncResult result={result} /> : null}
    </section>
  );
}

function ProviderStatusSummary({
  isOAuthPending,
  oauthError,
  onStartOAuth,
  provider,
}: {
  isOAuthPending: boolean;
  oauthError: string | null;
  onStartOAuth: () => void;
  provider: ProviderOption;
}) {
  const status = provider.status;

  if (!status) {
    return (
      <div className={styles.errorNotice}>
        Status is unavailable for {provider.descriptor.displayName}.
      </div>
    );
  }

  return (
    <div className={styles.statusSummary}>
      <div>
        <strong>{actionLabel(provider.descriptor, status)}</strong>
        <span>{actionDetail(provider.descriptor, status)}</span>
      </div>
      {provider.descriptor.workflowEndpoints.oauthStart ? (
        <button
          className={styles.oauthButton}
          disabled={!status.configured || isOAuthPending}
          onClick={onStartOAuth}
          type="button"
        >
          {isOAuthPending ? "Starting OAuth..." : "Login / restart OAuth"}
        </button>
      ) : null}
      {oauthError ? <div className={styles.errorNotice}>{oauthError}</div> : null}
      {status.accounts.length > 0 ? (
        <div className={styles.accountGrid}>
          {status.accounts.map((account) => (
            <div className={styles.accountRow} key={account.providerInstanceId}>
              <span>{account.providerInstanceId}</span>
              <span>{account.tokenStatus}</span>
              <span>
                {account.lastSyncAt ? `Last sync ${formatDateTime(account.lastSyncAt)}` : "No sync yet"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SyncResult({ result }: { result: ApiResult<ProviderSyncResponse> }) {
  if (!result.ok) {
    return <ErrorBlock result={result} />;
  }

  const created = result.data.batches.reduce(
    (sum, batch) =>
      sum + Object.values(batch.metricsCreated).reduce((batchSum, count) => batchSum + count, 0),
    0,
  );

  return (
    <div className={styles.result}>
      <strong>
        Synced {result.data.batches.length} batches, created {created} metrics
      </strong>
      <span>
        {result.data.providerCode}: {result.data.requestedFrom} - {result.data.requestedTo}
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

function ErrorBlock({ result }: { result: ApiResult<unknown> }) {
  if (result.ok) return null;

  return (
    <div className={styles.errorNotice}>
      {result.status ? <strong>HTTP {result.status}: </strong> : null}
      {result.message}
    </div>
  );
}

function actionLabel(descriptor: ProviderDescriptor, status: ProviderStatus): string {
  switch (status.nextAction) {
    case "configure":
      return `${descriptor.displayName} is not configured`;
    case "connect":
      return `${descriptor.displayName} needs OAuth`;
    case "reconnect":
      return `${descriptor.displayName} needs reconnection`;
    case "sync":
      return `${descriptor.displayName} is ready to sync`;
  }
}

function actionDetail(descriptor: ProviderDescriptor, status: ProviderStatus): string {
  switch (status.nextAction) {
    case "configure":
      return `Set the ${descriptor.displayName} credentials and token encryption key on the backend.`;
    case "connect":
      return descriptor.workflowEndpoints.oauthStart
        ? "Login before syncing this provider."
        : "Connect this provider before syncing.";
    case "reconnect":
      return descriptor.workflowEndpoints.oauthStart
        ? "Restart OAuth if provider access was revoked."
        : "Reconnect this provider before syncing.";
    case "sync":
      return status.accounts.length === 1
        ? `Connected as ${status.accounts[0].providerInstanceId}.`
        : `${status.accounts.length} connected accounts.`;
  }
}

function selectedDataTypes(formData: FormData): string[] | undefined {
  const dataTypes = formData.getAll("dataTypes").map(String).filter(Boolean);
  return dataTypes.length > 0 ? dataTypes : undefined;
}

function formatDataType(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
