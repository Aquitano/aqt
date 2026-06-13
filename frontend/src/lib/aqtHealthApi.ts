import type {
  ApiResult,
  HealthDataPageData,
  HealthDayModuleName,
  HealthDayResponse,
  IngestionBatchDetailResponse,
  IngestionsPageData,
  MetricCatalogResponse,
  ProviderCatalogResponse,
  ProviderDisconnectResponse,
  ProviderOAuthStartResponse,
  ProviderAccountListResponse,
  ProviderAccountStatus,
  ProviderSyncPageData,
  TrendsPageData,
  ProviderStatusCatalogResponse,
  ProviderSyncRequest,
  ProviderSyncJobStartResponse,
  ProviderSyncJobStatusResponse,
  ProviderSyncResponse,
  ScheduledSyncConfig,
  ScheduledSyncConfigUpdateRequest,
  ScheduledSyncRunResponse,
  HealthStatusData,
 } from "./types";
import { createAqtHealthClient } from "./aqtHealthClient";
import {
  addUtcDays,
  dateOnlyToUtcInstant,
  dayAfterDateOnlyToUtcInstant,
} from "./dates";

export async function getHealthStatus(): Promise<HealthStatusData> {
  const client = createAqtHealthClient();
  return {
    apiBaseUrl: client.apiBaseUrl,
    health: await client.getHealth(),
  };
}

export async function getHealthDataPageData(
  fromDate: string,
  toDate: string,
  timezone: string,
): Promise<HealthDataPageData> {
  const client = createAqtHealthClient();
  const apiBaseUrl = client.apiBaseUrl;
  const metricCatalog = await getMetricCatalog();
  const measurementsFrom = dateOnlyToUtcInstant(fromDate);
  const measurementsTo = dayAfterDateOnlyToUtcInstant(toDate);

  const [
    health,
    summary,
    trends,
    healthDay,
    dailySteps,
    activitySummaries,
    bodyMeasurements,
    latestHeartRate,
    latestSleep,
    sleepSummaries,
    respiratoryRates,
    hrvSamples,
    latestActivity,
    latestSleepSummary,
    latestRespiratoryRate,
    latestHrv,
    bloodPressure,
    latestBloodPressure,
    cardiovascular,
    latestCardiovascular,
    extendedBodyMeasurements,
    latestExtendedBodyMeasurement,
  ] = await Promise.all([
    client.getHealth(),
    client.getDashboardSummary({
      fromDate,
      toDate,
    }),
    client.getDashboardTrends({
      periodDays: 7,
      toDate,
    }),
    getHealthDay({
      date: toDate,
      timezone,
      modules: ["steps", "heartRate", "weight", "sleep"],
      includeSource: true,
    }),
    client.listDailyStepSummaries({ fromDate, toDate, includeSource: true }),
    client.listActivitySummaries({
      fromDate,
      toDate,
      includeSource: true,
      sort: "date",
      order: "desc",
      limit: 5000,
    }),
    client.listBodyMeasurements({
      from: measurementsFrom,
      to: measurementsTo,
      includeSource: true,
      sort: "measuredAt",
      order: "desc",
      limit: 5000,
    }),
    client.listHeartRateSamples({ latest: true, includeSource: true }),
    client.listSleepNights({ date: toDate, timezone, includeSource: true }),
    client.listSleepSummaries({
      from: measurementsFrom,
      to: measurementsTo,
      includeSource: true,
      sort: "endAt",
      order: "desc",
      limit: 5000,
    }),
    client.listRespiratoryRateSamples({
      from: measurementsFrom,
      to: measurementsTo,
      includeSource: true,
      sort: "measuredAt",
      order: "desc",
      limit: 5000,
    }),
    client.listHrvSamples({
      from: measurementsFrom,
      to: measurementsTo,
      includeSource: true,
      sort: "measuredAt",
      order: "desc",
      limit: 5000,
    }),
    client.getLatestActivitySummary({ date: toDate, includeSource: true }),
    client.getLatestSleepSummary({ includeSource: true }),
    client.listRespiratoryRateSamples({ latest: true, includeSource: true }),
    client.listHrvSamples({ latest: true, includeSource: true }),
    client.listBloodPressure({
      from: measurementsFrom,
      to: measurementsTo,
      includeSource: true,
      sort: "measuredAt",
      order: "desc",
      limit: 5000,
    }),
    client.getLatestBloodPressure({ includeSource: true }),
    client.listCardiovascular({
      from: measurementsFrom,
      to: measurementsTo,
      includeSource: true,
      sort: "measuredAt",
      order: "desc",
      limit: 5000,
    }),
    client.getLatestCardiovascular({ includeSource: true }),
    client.listExtendedBodyMeasurements({
      from: measurementsFrom,
      to: measurementsTo,
      includeSource: true,
      sort: "measuredAt",
      order: "desc",
      limit: 5000,
    }),
    client.getLatestExtendedBodyMeasurement({ includeSource: true }),
  ]);

  return {
    apiBaseUrl,
    health,
    summary,
    trends,
    healthDay,
    dailySteps,
    activitySummaries,
    bodyMeasurements,
    latestHeartRate,
    latestSleep,
    sleepSummaries,
    respiratoryRates,
    hrvSamples,
    latestActivity,
    latestSleepSummary,
    latestRespiratoryRate,
    latestHrv,
    bloodPressure,
    latestBloodPressure,
    cardiovascular,
    latestCardiovascular,
    extendedBodyMeasurements,
    latestExtendedBodyMeasurement,
    metricCatalog,
  };
}

export async function getTrendsPageData(
  toDate: string,
  days: number,
): Promise<TrendsPageData> {
  const client = createAqtHealthClient();
  const fromDate = addUtcDays(toDate, -(days - 1));
  const from = dateOnlyToUtcInstant(fromDate);
  const to = dayAfterDateOnlyToUtcInstant(toDate);
  const sampleQuery = {
    from,
    to,
    includeSource: true,
    sort: "measuredAt" as const,
    order: "asc" as const,
    limit: 5000,
  };

  const [health, weight, steps, sleep, hrv, activity, respiratory] = await Promise.all([
    client.getHealth(),
    client.listBodyMeasurements(sampleQuery),
    client.listDailyStepSummaries({ fromDate, toDate, includeSource: true }),
    client.listSleepSummaries({
      from,
      to,
      includeSource: true,
      sort: "endAt",
      order: "asc",
      limit: 5000,
    }),
    client.listHrvSamples(sampleQuery),
    client.listActivitySummaries({
      fromDate,
      toDate,
      includeSource: true,
      sort: "date",
      order: "asc",
      limit: 5000,
    }),
    client.listRespiratoryRateSamples(sampleQuery),
  ]);

  return {
    apiBaseUrl: client.apiBaseUrl,
    health,
    fromDate,
    toDate,
    weight,
    steps,
    sleep,
    hrv,
    activity,
    respiratory,
  };
}

export async function getProviderSyncPageData(): Promise<ProviderSyncPageData> {
  const client = createAqtHealthClient();
  const [health, providerCatalog, providerStatuses] = await Promise.all([
    client.getHealth(),
    getProviderCatalog(),
    getProviderStatuses(),
  ]);
  const scheduledSyncConfigs =
    providerStatuses.ok
      ? await Promise.all(
          providerStatuses.data.providers.flatMap((provider) =>
            provider.accounts.map((account) =>
              client.getScheduledSyncConfig(
                provider.providerCode,
                account.providerInstanceId,
              ) as Promise<ApiResult<ScheduledSyncConfig>>,
            ),
          ),
        )
      : [];

  return {
    apiBaseUrl: client.apiBaseUrl,
    health,
    providerCatalog,
    providerStatuses,
    scheduledSyncConfigs,
  };
}

export async function getIngestionsPageData(options: {
  limit: string;
  status?: string;
}): Promise<IngestionsPageData> {
  const client = createAqtHealthClient();
  const limit = toPositiveInteger(options.limit) ?? 25;
  const status = ingestionStatus(options.status);

  const [health, batches, failures] = await Promise.all([
    client.getHealth(),
    client.listIngestionBatches({ limit, status }),
    client.listIngestionFailures({ limit }),
  ]);

  return {
    apiBaseUrl: client.apiBaseUrl,
    health,
    batches,
    failures,
  };
}

export async function getIngestionBatchDetail(
  id: string,
): Promise<ApiResult<IngestionBatchDetailResponse>> {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: "Ingestion batch id must be a positive integer." };
  }

  return createAqtHealthClient().getIngestionBatch(parsed);
}

export async function getHealthDay(paramsValue: {
  date: string;
  timezone: string;
  modules: HealthDayModuleName[];
  includeSource?: boolean;
}): Promise<ApiResult<HealthDayResponse>> {
  return createAqtHealthClient().getHealthDay({
    date: paramsValue.date,
    timezone: paramsValue.timezone,
    modules: paramsValue.modules.join(","),
    includeSource: paramsValue.includeSource ?? false,
  });
}

export async function getMetricCatalog(): Promise<ApiResult<MetricCatalogResponse>> {
  return createAqtHealthClient().getMetricCatalog();
}

export async function getProviderCatalog(): Promise<ApiResult<ProviderCatalogResponse>> {
  return createAqtHealthClient().listProviders();
}

export async function getProviderStatuses(): Promise<ApiResult<ProviderStatusCatalogResponse>> {
  return createAqtHealthClient().listProviderStatuses();
}

export async function startProviderOAuth(
  providerCode: string,
): Promise<ApiResult<ProviderOAuthStartResponse>> {
  return createAqtHealthClient().startProviderOAuth(providerCode);
}

export async function listProviderAccounts(
  providerCode: string,
): Promise<ApiResult<ProviderAccountListResponse>> {
  return createAqtHealthClient().listProviderAccounts(providerCode);
}

export async function getProviderAccount(
  providerCode: string,
  providerInstanceId: string,
): Promise<ApiResult<ProviderAccountStatus>> {
  return createAqtHealthClient().getProviderAccount(providerCode, providerInstanceId);
}

export async function disconnectProviderAccount(
  providerCode: string,
  providerInstanceId: string,
): Promise<ApiResult<ProviderDisconnectResponse>> {
  return createAqtHealthClient().disconnectProviderAccount(providerCode, providerInstanceId);
}

export async function reconnectProviderAccount(
  providerCode: string,
  providerInstanceId: string,
): Promise<ApiResult<ProviderOAuthStartResponse>> {
  return createAqtHealthClient().reconnectProviderAccount(providerCode, providerInstanceId);
}

export async function syncProvider(
  providerCode: string,
  payload: ProviderSyncRequest,
): Promise<ApiResult<ProviderSyncResponse>> {
  return createAqtHealthClient().syncProvider(providerCode, payload);
}

export async function startProviderSyncJob(
  providerCode: string,
  payload: ProviderSyncRequest,
): Promise<ApiResult<ProviderSyncJobStartResponse>> {
  return createAqtHealthClient().startProviderSyncJob(providerCode, payload);
}

export async function getProviderSyncJob(
  providerCode: string,
  jobId: string,
): Promise<ApiResult<ProviderSyncJobStatusResponse>> {
  return createAqtHealthClient().getProviderSyncJob(providerCode, jobId);
}

export async function getScheduledSyncConfig(
  providerCode: string,
  providerInstanceId: string,
): Promise<ApiResult<ScheduledSyncConfig>> {
  return createAqtHealthClient().getScheduledSyncConfig(providerCode, providerInstanceId);
}

export async function updateScheduledSyncConfig(
  providerCode: string,
  providerInstanceId: string,
  payload: ScheduledSyncConfigUpdateRequest,
): Promise<ApiResult<ScheduledSyncConfig>> {
  return createAqtHealthClient().updateScheduledSyncConfig(providerCode, providerInstanceId, payload);
}

export async function runScheduledSyncNow(
  providerCode: string,
  providerInstanceId: string,
): Promise<ApiResult<ScheduledSyncRunResponse>> {
  return createAqtHealthClient().runScheduledSyncNow(providerCode, providerInstanceId);
}

function ingestionStatus(value?: string): "processed" | "failed" | undefined {
  if (value === "processed" || value === "failed") return value;
  return undefined;
}

function toPositiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
