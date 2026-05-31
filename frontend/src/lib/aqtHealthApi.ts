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
  ProviderStatusCatalogResponse,
  ProviderSyncRequest,
  ProviderSyncResponse,
  HealthStatusData,
} from "./types";
import { createAqtHealthClient } from "./aqtHealthClient";
import {
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
    metricCatalog,
  };
}

export async function getProviderSyncPageData(): Promise<ProviderSyncPageData> {
  const client = createAqtHealthClient();
  const [health, providerCatalog, providerStatuses] = await Promise.all([
    client.getHealth(),
    getProviderCatalog(),
    getProviderStatuses(),
  ]);

  return {
    apiBaseUrl: client.apiBaseUrl,
    health,
    providerCatalog,
    providerStatuses,
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

function ingestionStatus(value?: string): "processed" | "failed" | undefined {
  if (value === "processed" || value === "failed") return value;
  return undefined;
}

function toPositiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
