"use client";

import { FormEvent, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  ApiResult,
  ProviderCatalogResponse,
  ProviderDescriptor,
  ProviderOAuthStartResponse,
  ProviderAccountStatus,
  ProviderStatus,
  ProviderStatusCatalogResponse,
  ScheduledSyncConfig,
  ScheduledSyncRunResponse,
  ProviderSyncRequest,
  ProviderSyncResponse,
  ProviderSyncJobStatusResponse,
} from "@/lib/types";
import styles from "./ProviderSyncPanel.module.css";

type ProviderSyncPanelProps = {
  catalog: ApiResult<ProviderCatalogResponse>;
  statuses: ApiResult<ProviderStatusCatalogResponse>;
  scheduledSyncConfigs: ApiResult<ScheduledSyncConfig>[];
};

type ProviderOption = {
  descriptor: ProviderDescriptor;
  status?: ProviderStatus;
};

export function ProviderSyncPanel({ catalog, statuses, scheduledSyncConfigs }: ProviderSyncPanelProps) {
  const router = useRouter();
  const [selectedProviderCode, setSelectedProviderCode] = useState("");
  const [result, setResult] = useState<ApiResult<ProviderSyncResponse> | null>(null);
  const [syncJob, setSyncJob] = useState<ProviderSyncJobStatusResponse | null>(null);
  const [activeSyncJob, setActiveSyncJob] = useState<ActiveSyncJob | null>(() => readStoredSyncJob());
  const [isSyncing, setIsSyncing] = useState(() => activeSyncJob != null);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [accountActionError, setAccountActionError] = useState<string | null>(null);
  const [pendingAccountAction, setPendingAccountAction] = useState<string | null>(null);
  const [scheduledResult, setScheduledResult] = useState<ApiResult<ScheduledSyncRunResponse> | null>(null);
  const [scheduledError, setScheduledError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isOAuthPending, startOAuthTransition] = useTransition();
  const [, startAccountActionTransition] = useTransition();
  const [, startScheduledTransition] = useTransition();

  useEffect(() => {
    if (!activeSyncJob) return;

    const pollingJob = activeSyncJob;
    let stopped = false;

    async function poll() {
      while (!stopped) {
        try {
          const response = await fetch(
            `/api/providers/${encodeURIComponent(pollingJob.providerCode)}/sync-jobs/${encodeURIComponent(pollingJob.jobId)}`,
          );
          const body = (await response.json()) as ApiResult<ProviderSyncJobStatusResponse>;
          if (!body.ok) {
            setResult(body);
            setSyncJob(null);
            setIsSyncing(false);
            clearStoredSyncJob();
            setActiveSyncJob(null);
            return;
          }

          setSyncJob(body.data);
          if (isFinishedSyncJob(body.data.status)) {
            setResult(
              body.data.summary
                ? { ok: true, data: body.data.summary }
                : { ok: false, message: body.data.errorMessage ?? "Provider sync job failed." },
            );
            setIsSyncing(false);
            clearStoredSyncJob();
            setActiveSyncJob(null);
            router.refresh();
            return;
          }
        } catch (error) {
          setResult({
            ok: false,
            message: error instanceof Error ? error.message : "Provider sync status check failed.",
          });
        }

        await delay(SYNC_JOB_POLL_INTERVAL_MS);
      }
    }

    void poll();

    return () => {
      stopped = true;
    };
  }, [activeSyncJob, router]);

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
  const scheduledConfigByAccount = new Map(
    scheduledSyncConfigs
      .filter((config): config is { ok: true; data: ScheduledSyncConfig } => config.ok)
      .map((config) => [`${config.data.providerCode}:${config.data.providerInstanceId}`, config.data]),
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProvider || !canSync) return;
    setResult(null);
    setSyncJob(null);
    setIsSyncing(true);

    const formData = new FormData(event.currentTarget);
    const dataTypes = selectedDataTypes(formData);
    const payload = {
      from: toIso(formData.get("from")),
      to: toIso(formData.get("to")),
      dataTypes,
      pageSize: selectedProvider.descriptor.supportsPageSize
        ? toPositiveInteger(formData.get("pageSize"))
        : undefined,
    };

    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/providers/${encodeURIComponent(selectedProvider.descriptor.providerCode)}/sync-jobs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = (await response.json()) as ApiResult<{ jobId: string }>;
        if (!body.ok) {
          setResult(body);
          setIsSyncing(false);
          return;
        }

        const activeJob = {
          providerCode: selectedProvider.descriptor.providerCode,
          jobId: body.data.jobId,
        };
        storeSyncJob(activeJob);
        setActiveSyncJob(activeJob);
      } catch (error) {
        setResult({
          ok: false,
          message: error instanceof Error ? error.message : "Provider sync failed. Try again.",
        });
        setIsSyncing(false);
      }
    });
  }

  function onStartOAuth() {
    if (!selectedProvider?.descriptor.workflowEndpoints.oauthStart) return;
    setResult(null);
    setOAuthError(null);
    setAccountActionError(null);

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

  function onDisconnect(providerInstanceId: string) {
    if (!selectedProvider) return;
    setResult(null);
    setAccountActionError(null);
    setPendingAccountAction(`disconnect:${providerInstanceId}`);

    startAccountActionTransition(async () => {
      try {
        const response = await fetch(
          `/api/providers/${encodeURIComponent(selectedProvider.descriptor.providerCode)}/accounts/${encodeURIComponent(providerInstanceId)}/disconnect`,
          { method: "POST" },
        );
        const body = (await response.json()) as ApiResult<unknown>;
        if (body.ok) {
          router.refresh();
        } else {
          setAccountActionError(body.message);
        }
      } catch {
        setAccountActionError("Disconnect failed. Try again.");
      } finally {
        setPendingAccountAction(null);
      }
    });
  }

  function onReconnect(providerInstanceId: string) {
    if (!selectedProvider) return;
    setResult(null);
    setAccountActionError(null);
    setPendingAccountAction(`reconnect:${providerInstanceId}`);

    startAccountActionTransition(async () => {
      try {
        const response = await fetch(
          `/api/providers/${encodeURIComponent(selectedProvider.descriptor.providerCode)}/accounts/${encodeURIComponent(providerInstanceId)}/reconnect`,
          { method: "POST" },
        );
        const body = (await response.json()) as ApiResult<ProviderOAuthStartResponse>;
        if (body.ok) {
          window.location.assign(body.data.authorizationUrl);
        } else {
          setAccountActionError(body.message);
        }
      } catch {
        setAccountActionError("Reconnect failed. Try again.");
      } finally {
        setPendingAccountAction(null);
      }
    });
  }

  function onToggleScheduled(providerInstanceId: string, enabled: boolean) {
    if (!selectedProvider) return;
    setScheduledError(null);
    setScheduledResult(null);
    setPendingAccountAction(`scheduled:${providerInstanceId}`);
    const config = scheduledConfigByAccount.get(
      `${selectedProvider.descriptor.providerCode}:${providerInstanceId}`,
    );

    startScheduledTransition(async () => {
      try {
        const response = await fetch(
          `/api/providers/${encodeURIComponent(selectedProvider.descriptor.providerCode)}/accounts/${encodeURIComponent(providerInstanceId)}/scheduled-sync`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              enabled,
              dataTypes: config?.dataTypes ?? selectedProvider.descriptor.defaultDataTypes,
              cadenceMinutes: config?.cadenceMinutes ?? 1440,
              lookbackDays: config?.lookbackDays ?? 7,
            }),
          },
        );
        const body = (await response.json()) as ApiResult<ScheduledSyncConfig>;
        if (body.ok) router.refresh();
        else setScheduledError(body.message);
      } catch {
        setScheduledError("Automatic sync update failed. Try again.");
      } finally {
        setPendingAccountAction(null);
      }
    });
  }

  function onRunScheduled(providerInstanceId: string) {
    if (!selectedProvider) return;
    setScheduledError(null);
    setScheduledResult(null);
    setPendingAccountAction(`scheduled-run:${providerInstanceId}`);

    startScheduledTransition(async () => {
      try {
        const response = await fetch(
          `/api/providers/${encodeURIComponent(selectedProvider.descriptor.providerCode)}/accounts/${encodeURIComponent(providerInstanceId)}/scheduled-sync/run`,
          { method: "POST" },
        );
        const body = (await response.json()) as ApiResult<ScheduledSyncRunResponse>;
        setScheduledResult(body);
        if (body.ok) router.refresh();
      } catch {
        setScheduledError("Automatic sync run failed. Try again.");
      } finally {
        setPendingAccountAction(null);
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
          accountActionError={accountActionError}
          oauthError={oauthError}
          pendingAccountAction={pendingAccountAction}
          onDisconnect={onDisconnect}
          onReconnect={onReconnect}
          onRunScheduled={onRunScheduled}
          onStartOAuth={onStartOAuth}
          onToggleScheduled={onToggleScheduled}
          provider={selectedProvider}
          scheduledConfigByAccount={scheduledConfigByAccount}
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
          <button className={styles.submit} type="submit" disabled={isPending || isSyncing || !canSync}>
            {isPending || isSyncing ? (
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

      {syncJob ? <SyncProgressView job={syncJob} /> : null}
      {result ? <SyncResult result={result} /> : null}
      {scheduledError ? <div className={styles.errorNotice}>{scheduledError}</div> : null}
      {scheduledResult ? <ScheduledRunResult result={scheduledResult} /> : null}
    </section>
  );
}

type ActiveSyncJob = {
  providerCode: string;
  jobId: string;
};

type SyncItem = {
  label: string;
  payload: ProviderSyncRequest;
};

function SyncProgressView({ job }: { job: ProviderSyncJobStatusResponse }) {
  const completedPercent = job.totalItems > 0
    ? Math.round((job.completedItems / job.totalItems) * 100)
    : 0;
  const startedAt = job.startedAt ?? job.createdAt;
  const elapsedSeconds = Math.max(0, Math.round((new Date(job.updatedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const currentLabel = job.currentItem
    ? `${formatDataType(job.currentItem.dataType)} ${formatWindowLabel(new Date(job.currentItem.from), new Date(job.currentItem.to))}`
    : "Waiting for backend worker";
  const lastLabel = job.lastCompletedItem
    ? `${formatDataType(job.lastCompletedItem.dataType)} ${formatWindowLabel(new Date(job.lastCompletedItem.from), new Date(job.lastCompletedItem.to))}`
    : null;

  return (
    <div className={styles.progressPanel}>
      <div className={styles.progressHeader}>
        <div>
          <strong>Sync {formatStatus(job.status)}</strong>
          <span>
            {job.completedItems} of {job.totalItems || "?"} windows complete, {elapsedSeconds}s elapsed
          </span>
        </div>
      </div>
      <div className={styles.progressTrack} aria-label="Provider sync progress">
        <div className={styles.progressFill} style={{ width: `${completedPercent}%` }} />
      </div>
      <div className={styles.progressMeta}>
        <span>{completedPercent}%</span>
        <span>{isFinishedSyncJob(job.status) ? "Finished" : currentLabel}</span>
      </div>
      {lastLabel ? <small>Last completed: {lastLabel}</small> : null}
      <small>Job {job.jobId}</small>
    </div>
  );
}

function ProviderStatusSummary({
  isOAuthPending,
  accountActionError,
  oauthError,
  pendingAccountAction,
  onDisconnect,
  onReconnect,
  onRunScheduled,
  onStartOAuth,
  onToggleScheduled,
  provider,
  scheduledConfigByAccount,
}: {
  isOAuthPending: boolean;
  accountActionError: string | null;
  oauthError: string | null;
  pendingAccountAction: string | null;
  onDisconnect: (providerInstanceId: string) => void;
  onReconnect: (providerInstanceId: string) => void;
  onRunScheduled: (providerInstanceId: string) => void;
  onStartOAuth: () => void;
  onToggleScheduled: (providerInstanceId: string, enabled: boolean) => void;
  provider: ProviderOption;
  scheduledConfigByAccount: Map<string, ScheduledSyncConfig>;
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
          {isOAuthPending ? "Starting OAuth..." : primaryOAuthLabel(status)}
        </button>
      ) : null}
      {oauthError ? <div className={styles.errorNotice}>{oauthError}</div> : null}
      {accountActionError ? <div className={styles.errorNotice}>{accountActionError}</div> : null}
      {status.accounts.length > 0 ? (
        <div className={styles.accountGrid}>
          {status.accounts.map((account) => (
            <ProviderAccountRow
              account={account}
              key={account.providerInstanceId}
              onDisconnect={onDisconnect}
              onReconnect={onReconnect}
              onRunScheduled={onRunScheduled}
              onToggleScheduled={onToggleScheduled}
              pendingAccountAction={pendingAccountAction}
              scheduledConfig={scheduledConfigByAccount.get(
                `${provider.descriptor.providerCode}:${account.providerInstanceId}`,
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProviderAccountRow({
  account,
  onDisconnect,
  onReconnect,
  onRunScheduled,
  onToggleScheduled,
  pendingAccountAction,
  scheduledConfig,
}: {
  account: ProviderAccountStatus;
  onDisconnect: (providerInstanceId: string) => void;
  onReconnect: (providerInstanceId: string) => void;
  onRunScheduled: (providerInstanceId: string) => void;
  onToggleScheduled: (providerInstanceId: string, enabled: boolean) => void;
  pendingAccountAction: string | null;
  scheduledConfig?: ScheduledSyncConfig;
}) {
  const disconnectPending = pendingAccountAction === `disconnect:${account.providerInstanceId}`;
  const reconnectPending = pendingAccountAction === `reconnect:${account.providerInstanceId}`;
  const scheduledPending = pendingAccountAction === `scheduled:${account.providerInstanceId}`;
  const scheduledRunPending = pendingAccountAction === `scheduled-run:${account.providerInstanceId}`;

  return (
    <div className={styles.accountRow}>
      <div className={styles.accountIdentity}>
        <strong>{account.providerInstanceId}</strong>
        <span>{formatStatus(account.status)} account</span>
      </div>
      <dl className={styles.accountMeta}>
        <div>
          <dt>Token</dt>
          <dd>{formatStatus(account.tokenStatus)}</dd>
        </div>
        <div>
          <dt>Connected</dt>
          <dd>{account.connectedAt ? formatDateTime(account.connectedAt) : "Never"}</dd>
        </div>
        {account.disconnectedAt ? (
          <div>
            <dt>Disconnected</dt>
            <dd>{formatDateTime(account.disconnectedAt)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Last sync</dt>
          <dd>{account.lastSyncAt ? formatDateTime(account.lastSyncAt) : "None"}</dd>
        </div>
        {account.lastTokenRefreshAt ? (
          <div>
            <dt>Refresh</dt>
            <dd>
              {formatStatus(account.lastTokenRefreshStatus ?? "unknown")} {formatDateTime(account.lastTokenRefreshAt)}
            </dd>
          </div>
        ) : null}
        {account.lastAuthErrorCode ? (
          <div className={styles.accountError}>
            <dt>{account.lastAuthErrorCode}</dt>
            <dd>{account.lastAuthErrorMessage ?? "Authentication failed"}</dd>
          </div>
        ) : null}
        <div className={styles.scheduledMeta}>
          <dt>Automatic</dt>
          <dd>
            {scheduledConfig?.enabled ? "Enabled" : "Paused"}
            {scheduledConfig?.nextRunAt ? `, next ${formatDateTime(scheduledConfig.nextRunAt)}` : ""}
          </dd>
        </div>
        {scheduledConfig?.lastErrorMessage ? (
          <div className={styles.accountError}>
            <dt>Scheduled sync error</dt>
            <dd>{scheduledConfig.lastErrorMessage}</dd>
          </div>
        ) : null}
      </dl>
      <div className={styles.accountActions}>
        {account.status === "connected" ? (
          <>
            <button
              className={styles.secondaryButton}
              disabled={scheduledPending || scheduledRunPending}
              onClick={() => onToggleScheduled(account.providerInstanceId, !scheduledConfig?.enabled)}
              type="button"
            >
              {scheduledPending ? "Saving..." : scheduledConfig?.enabled ? "Pause auto" : "Enable auto"}
            </button>
            <button
              className={styles.oauthButton}
              disabled={scheduledPending || scheduledRunPending}
              onClick={() => onRunScheduled(account.providerInstanceId)}
              type="button"
            >
              {scheduledRunPending ? "Running..." : "Run auto now"}
            </button>
          </>
        ) : null}
        {account.status === "connected" ? (
          <button
            className={styles.secondaryButton}
            disabled={disconnectPending || reconnectPending}
            onClick={() => onDisconnect(account.providerInstanceId)}
            type="button"
          >
            {disconnectPending ? "Disconnecting..." : "Disconnect"}
          </button>
        ) : null}
        {account.status === "needs_reauth" || account.status === "disconnected" ? (
          <button
            className={styles.oauthButton}
            disabled={disconnectPending || reconnectPending}
            onClick={() => onReconnect(account.providerInstanceId)}
            type="button"
          >
            {reconnectPending ? "Starting..." : "Reconnect"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ScheduledRunResult({ result }: { result: ApiResult<ScheduledSyncRunResponse> }) {
  if (!result.ok) return <ErrorBlock result={result} />;

  return (
    <div className={styles.result}>
      <strong>Automatic sync {result.data.status}</strong>
      <span>
        {result.data.providerCode}: {result.data.requestedFrom ?? "n/a"} - {result.data.requestedTo ?? "n/a"}
      </span>
      {result.data.errors.length > 0 ? (
        <ul>
          {result.data.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
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

export function buildProviderSyncItems(
  descriptor: ProviderDescriptor,
  payload: ProviderSyncRequest,
): SyncItem[] {
  const dataTypes = payload.dataTypes && payload.dataTypes.length > 0
    ? payload.dataTypes
    : descriptor.defaultDataTypes;
  const from = parseSyncInstant(payload.from);
  const to = parseSyncInstant(payload.to);

  if (!from || !to || from.getTime() >= to.getTime()) {
    return [{
      label: "Default sync window",
      payload: {
        ...payload,
        dataTypes: dataTypes.length > 0 ? dataTypes : undefined,
      },
    }];
  }

  return dataTypes.flatMap((dataType) =>
    syncWindows(from, to, providerProgressWindowDays()).map((window) => ({
      label: `${formatDataType(dataType)} ${formatWindowLabel(window.from, window.to)}`,
      payload: {
        ...payload,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        dataTypes: [dataType],
      },
    })),
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

export function actionLabel(descriptor: ProviderDescriptor, status: ProviderStatus): string {
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

export function actionDetail(descriptor: ProviderDescriptor, status: ProviderStatus): string {
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

export function primaryOAuthLabel(status: ProviderStatus): string {
  switch (status.nextAction) {
    case "connect":
      return "Connect";
    case "reconnect":
      return "Reconnect";
    default:
      return "Start OAuth";
  }
}

export function formatStatus(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function parseSyncInstant(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function syncWindows(
  from: Date,
  to: Date,
  windowDays: number,
): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  let windowFrom = from.getTime();
  const targetTo = to.getTime();

  while (windowFrom < targetTo) {
    const windowTo = Math.min(windowFrom + windowMs, targetTo);
    windows.push({ from: new Date(windowFrom), to: new Date(windowTo) });
    windowFrom = windowTo;
  }

  return windows.length > 0 ? windows : [{ from, to }];
}

function providerProgressWindowDays(): number {
  return 31;
}

function formatWindowLabel(from: Date, to: Date): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${formatter.format(from)} - ${formatter.format(to)}`;
}

function isFinishedSyncJob(status: string): boolean {
  return status === "processed" || status === "partial_failed" || status === "failed";
}

function readStoredSyncJob(): ActiveSyncJob | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SYNC_JOB_STORAGE_KEY);
  if (!raw) return null;
  return parseStoredSyncJob(raw);
}

function parseStoredSyncJob(raw: string): ActiveSyncJob | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveSyncJob>;
    return typeof parsed.providerCode === "string" && typeof parsed.jobId === "string"
      ? { providerCode: parsed.providerCode, jobId: parsed.jobId }
      : null;
  } catch {
    return null;
  }
}

function storeSyncJob(job: ActiveSyncJob) {
  window.localStorage.setItem(SYNC_JOB_STORAGE_KEY, JSON.stringify(job));
}

function clearStoredSyncJob() {
  window.localStorage.removeItem(SYNC_JOB_STORAGE_KEY);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const SYNC_JOB_STORAGE_KEY = "aqt-health.provider-sync.active-job";
const SYNC_JOB_POLL_INTERVAL_MS = 1500;
