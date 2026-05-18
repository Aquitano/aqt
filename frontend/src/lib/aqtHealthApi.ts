import type {
  ApiResult,
  BodyMeasurementLatestResponse,
  DashboardSummaryResponse,
  HealthDataPageData,
  HealthResponse,
  HealthStatusData,
  HealthDayModuleName,
  HealthDayResponse,
  HeartRateSamplesResponse,
  IngestionBatchDetailResponse,
  IngestionBatchesResponse,
  IngestionsPageData,
  MetricCatalogResponse,
  ProviderCatalogResponse,
  ProviderOAuthStartResponse,
  ProviderSyncPageData,
  ProviderStatusCatalogResponse,
  ProviderSyncRequest,
  ProviderSyncResponse,
  SleepNightsResponse,
  StepDailySummariesResponse,
} from "./types";
import { createAqtHealthClient } from "./aqtHealthClient";

export async function getHealthStatus(): Promise<HealthStatusData> {
  const client = createAqtHealthClient();
  return {
    apiBaseUrl: client.apiBaseUrl,
    health: asResult<HealthResponse>(await client.getHealth()),
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

  const [
    health,
    summary,
    healthDay,
    dailySteps,
    latestWeight,
    latestHeartRate,
    latestSleep,
  ] = await Promise.all([
    client.getHealth(),
    client.getDashboardSummary({
      fromDate,
      toDate,
    }),
    getHealthDay({
      date: toDate,
      timezone,
      modules: ["steps", "heartRate", "weight", "sleep"],
      includeSource: true,
    }),
    client.listDailyStepSummaries({ fromDate, toDate, includeSource: true }),
    client.getLatestBodyMeasurement({ metricType: "weight", includeSource: true }),
    client.listHeartRateSamples({ latest: true, includeSource: true }),
    client.listSleepNights({ date: toDate, timezone, includeSource: true }),
  ]);

  return {
    apiBaseUrl,
    health: asResult<HealthResponse>(health),
    summary: asResult<DashboardSummaryResponse>(summary),
    healthDay,
    dailySteps: asResult<StepDailySummariesResponse>(dailySteps),
    latestWeight: asResult<BodyMeasurementLatestResponse>(latestWeight),
    latestHeartRate: asResult<HeartRateSamplesResponse>(latestHeartRate),
    latestSleep: asResult<SleepNightsResponse>(latestSleep),
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
    health: asResult<HealthResponse>(health),
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
    health: asResult<HealthResponse>(health),
    batches: asResult<IngestionBatchesResponse>(batches),
    failures: asResult<IngestionBatchesResponse>(failures),
  };
}

export async function getIngestionBatchDetail(
  id: string,
): Promise<ApiResult<IngestionBatchDetailResponse>> {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: "Ingestion batch id must be a positive integer." };
  }

  return asResult<IngestionBatchDetailResponse>(
    await createAqtHealthClient().getIngestionBatch(parsed),
  );
}

export async function getHealthDay(paramsValue: {
  date: string;
  timezone: string;
  modules: HealthDayModuleName[];
  includeSource?: boolean;
}): Promise<ApiResult<HealthDayResponse>> {
  return asResult<HealthDayResponse>(
    await createAqtHealthClient().getHealthDay({
      date: paramsValue.date,
      timezone: paramsValue.timezone,
      modules: paramsValue.modules.join(","),
      includeSource: paramsValue.includeSource ?? false,
    }),
  );
}

export async function getMetricCatalog(): Promise<ApiResult<MetricCatalogResponse>> {
  return asResult<MetricCatalogResponse>(await createAqtHealthClient().getMetricCatalog());
}

export async function getProviderCatalog(): Promise<ApiResult<ProviderCatalogResponse>> {
  return asResult<ProviderCatalogResponse>(await createAqtHealthClient().listProviders());
}

export async function getProviderStatuses(): Promise<ApiResult<ProviderStatusCatalogResponse>> {
  return asResult<ProviderStatusCatalogResponse>(
    await createAqtHealthClient().listProviderStatuses(),
  );
}

export async function startProviderOAuth(
  providerCode: string,
): Promise<ApiResult<ProviderOAuthStartResponse>> {
  return asResult<ProviderOAuthStartResponse>(
    await createAqtHealthClient().startProviderOAuth(providerCode),
  );
}

export async function syncProvider(
  providerCode: string,
  payload: ProviderSyncRequest,
): Promise<ApiResult<ProviderSyncResponse>> {
  return asResult<ProviderSyncResponse>(
    await createAqtHealthClient().syncProvider(providerCode, payload),
  );
}

function asResult<T>(result: ApiResult<unknown>): ApiResult<T> {
  return result as ApiResult<T>;
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
