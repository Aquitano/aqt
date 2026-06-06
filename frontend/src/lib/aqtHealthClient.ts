import createClient from "openapi-fetch";
import type {
  ApiResult,
  ApiSchema,
  BloodPressureLatestResponse,
  BloodPressureMeasurementsResponse,
  CardiovascularMeasurementResponse,
  CardiovascularMeasurementsResponse,
  ExtendedBodyMeasurementResponse,
  ExtendedBodyMeasurementsResponse,
  ScheduledSyncConfig,
  ScheduledSyncConfigUpdateRequest,
  ScheduledSyncRunResponse,
} from "./types";
import type { paths } from "./generated/aqtHealthApiTypes";

type ClientResponse<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

type ClientOptions = {
  protected?: boolean;
};

type IngestionBatchQuery = NonNullable<
  paths["/api/v1/admin/ingestion/batches"]["get"]["parameters"]["query"]
>;
type IngestionFailuresQuery = NonNullable<
  paths["/api/v1/admin/ingestion/failures"]["get"]["parameters"]["query"]
>;
type ProviderPathCode =
  paths["/api/v1/providers/{providerCode}/sync"]["post"]["parameters"]["path"]["providerCode"];
type HealthDayQuery = NonNullable<paths["/api/v1/health/day"]["get"]["parameters"]["query"]>;
type DailyStepsQuery = NonNullable<
  paths["/api/v1/metrics/steps/daily"]["get"]["parameters"]["query"]
>;
type ActivitySummariesQuery = NonNullable<
  paths["/api/v1/activity/summaries"]["get"]["parameters"]["query"]
>;
type ActivitySummaryLatestQuery = NonNullable<
  paths["/api/v1/activity/summaries/latest"]["get"]["parameters"]["query"]
>;
type HeartRateSamplesQuery = NonNullable<
  paths["/api/v1/metrics/heart-rate"]["get"]["parameters"]["query"]
>;
type RespiratoryRateSamplesQuery = NonNullable<
  paths["/api/v1/metrics/respiratory-rate"]["get"]["parameters"]["query"]
>;
type HrvSamplesQuery = NonNullable<
  paths["/api/v1/metrics/hrv"]["get"]["parameters"]["query"]
>;
type SleepNightsQuery = NonNullable<paths["/api/v1/sleep/nights"]["get"]["parameters"]["query"]>;
type SleepSummariesQuery = NonNullable<
  paths["/api/v1/sleep/summaries"]["get"]["parameters"]["query"]
>;
type SleepSummaryLatestQuery = NonNullable<
  paths["/api/v1/sleep/summaries/latest"]["get"]["parameters"]["query"]
>;
type LatestBodyMeasurementQuery = NonNullable<
  paths["/api/v1/body/measurements/latest"]["get"]["parameters"]["query"]
>;
type BodyMeasurementsQuery = NonNullable<
  paths["/api/v1/body/measurements"]["get"]["parameters"]["query"]
>;
type DashboardSummaryQuery = NonNullable<
  paths["/api/v1/dashboard/summary"]["get"]["parameters"]["query"]
>;
type DashboardTrendsQuery = NonNullable<
  paths["/api/v1/dashboard/trends"]["get"]["parameters"]["query"]
>;
const defaultBaseUrl = "http://localhost:8080";
const backendRequestTimeoutMs = 8_000;
const longRunningBackendRequestTimeoutMs = 300_000;

export function apiBaseUrlFromEnv(): string {
  return process.env.AQT_HEALTH_API_BASE_URL ?? defaultBaseUrl;
}

export function createAqtHealthClient() {
  const apiBaseUrl = apiBaseUrlFromEnv();
  const rawClient = createClient<paths>({
    baseUrl: apiBaseUrl,
    fetch: (input: Request) => fetchWithTimeout(input),
  });
  const longRunningClient = createClient<paths>({
    baseUrl: apiBaseUrl,
    fetch: (input: Request) => fetchWithTimeout(input, undefined, longRunningBackendRequestTimeoutMs),
  });

  return {
    apiBaseUrl,

    getHealth: () =>
      call<ApiSchema<"HealthResponse">>(() => rawClient.GET("/api/v1/admin/health"), {
        protected: false,
      }),

    listIngestionBatches: (query: IngestionBatchQuery) =>
      call<ApiSchema<"IngestionBatchesResponse">>(
        (headers) =>
          rawClient.GET("/api/v1/admin/ingestion/batches", {
            headers,
            params: { query },
          }),
      ),

    getIngestionBatch: (id: number) =>
      call<ApiSchema<"IngestionBatchDetailResponse">>(
        (headers) =>
          rawClient.GET("/api/v1/admin/ingestion/batches/{id}", {
            headers,
            params: { path: { id } },
          }),
      ),

    listIngestionFailures: (query: IngestionFailuresQuery) =>
      call<ApiSchema<"IngestionBatchesResponse">>(
        (headers) =>
          rawClient.GET("/api/v1/admin/ingestion/failures", {
            headers,
            params: { query },
          }),
      ),

    listProviders: () =>
      call<ApiSchema<"ProviderCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v1/providers", { headers }),
      ),

    listProviderStatuses: () =>
      call<ApiSchema<"ProviderStatusCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v1/providers/status", { headers }),
      ),

    startProviderOAuth: (providerCode: string) =>
      call<ApiSchema<"ProviderOAuthStartResponse">>((headers) =>
        rawClient.GET("/api/v1/providers/{providerCode}/oauth/start", {
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    listProviderAccounts: (providerCode: string) =>
      call<ApiSchema<"ProviderAccountListResponseDto">>((headers) =>
        rawClient.GET("/api/v1/providers/{providerCode}/accounts", {
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    getProviderAccount: (providerCode: string, providerInstanceId: string) =>
      call<ApiSchema<"ProviderAccountStatusResponseDto">>((headers) =>
        rawClient.GET("/api/v1/providers/{providerCode}/accounts/{providerInstanceId}", {
          headers,
          params: {
            path: {
              providerCode: providerCode as ProviderPathCode,
              providerInstanceId,
            },
          },
        }),
      ),

    disconnectProviderAccount: (providerCode: string, providerInstanceId: string) =>
      call<ApiSchema<"ProviderDisconnectResponseDto">>((headers) =>
        rawClient.POST("/api/v1/providers/{providerCode}/accounts/{providerInstanceId}/disconnect", {
          headers,
          params: {
            path: {
              providerCode: providerCode as ProviderPathCode,
              providerInstanceId,
            },
          },
        }),
      ),

    reconnectProviderAccount: (providerCode: string, providerInstanceId: string) =>
      call<ApiSchema<"ProviderOAuthStartResponse">>((headers) =>
        rawClient.POST("/api/v1/providers/{providerCode}/accounts/{providerInstanceId}/reconnect", {
          headers,
          params: {
            path: {
              providerCode: providerCode as ProviderPathCode,
              providerInstanceId,
            },
          },
        }),
      ),

    getScheduledSyncConfig: (providerCode: string, providerInstanceId: string) =>
      call<ScheduledSyncConfig>((headers) =>
        rawClient.GET("/api/v1/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync", {
          headers,
          params: {
            path: {
              providerCode: providerCode as ProviderPathCode,
              providerInstanceId,
            },
          },
        }),
      ),

    updateScheduledSyncConfig: (
      providerCode: string,
      providerInstanceId: string,
      body: ScheduledSyncConfigUpdateRequest,
    ) =>
      call<ScheduledSyncConfig>((headers) =>
        rawClient.PUT("/api/v1/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync", {
          body,
          headers,
          params: {
            path: {
              providerCode: providerCode as ProviderPathCode,
              providerInstanceId,
            },
          },
        }),
      ),

    runScheduledSyncNow: (providerCode: string, providerInstanceId: string) =>
      call<ScheduledSyncRunResponse>((headers) =>
        longRunningClient.POST("/api/v1/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync/run", {
          headers,
          params: {
            path: {
              providerCode: providerCode as ProviderPathCode,
              providerInstanceId,
            },
          },
        }),
      ),

    syncProvider: (
      providerCode: string,
      body: ApiSchema<"ProviderSyncRequestDto">,
    ) =>
      call<ApiSchema<"ProviderSyncResponseDto">>((headers) =>
        longRunningClient.POST("/api/v1/providers/{providerCode}/sync", {
          body,
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    getMetricCatalog: () =>
      call<ApiSchema<"MetricCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v1/metrics/catalog", { headers }),
      ),

    getHealthDay: (query: HealthDayQuery) =>
      call<ApiSchema<"HealthDayResponse">>((headers) =>
        rawClient.GET("/api/v1/health/day", {
          headers,
          params: { query },
        }),
      ),

    listDailyStepSummaries: (query: DailyStepsQuery) =>
      call<ApiSchema<"StepDailySummariesResponse">>((headers) =>
        rawClient.GET("/api/v1/metrics/steps/daily", {
          headers,
          params: { query },
        }),
      ),

    listActivitySummaries: (query: ActivitySummariesQuery) =>
      call<ApiSchema<"ActivitySummariesResponse">>((headers) =>
        rawClient.GET("/api/v1/activity/summaries", {
          headers,
          params: { query },
        }),
      ),

    getLatestActivitySummary: (query: ActivitySummaryLatestQuery) =>
      call<ApiSchema<"ActivitySummaryLatestResponse">>((headers) =>
        rawClient.GET("/api/v1/activity/summaries/latest", {
          headers,
          params: { query },
        }),
      ),

    listHeartRateSamples: (query: HeartRateSamplesQuery) =>
      call<ApiSchema<"HeartRateSamplesResponse">>((headers) =>
        rawClient.GET("/api/v1/metrics/heart-rate", {
          headers,
          params: { query },
        }),
      ),

    listRespiratoryRateSamples: (query: RespiratoryRateSamplesQuery) =>
      call<ApiSchema<"RespiratoryRateSamplesResponse">>((headers) =>
        rawClient.GET("/api/v1/metrics/respiratory-rate", {
          headers,
          params: { query },
        }),
      ),

    listHrvSamples: (query: HrvSamplesQuery) =>
      call<ApiSchema<"HrvSamplesResponse">>((headers) =>
        rawClient.GET("/api/v1/metrics/hrv", {
          headers,
          params: { query },
        }),
      ),

    listSleepNights: (query: SleepNightsQuery) =>
      call<ApiSchema<"SleepNightsResponse">>((headers) =>
        rawClient.GET("/api/v1/sleep/nights", {
          headers,
          params: { query },
        }),
      ),

    listSleepSummaries: (query: SleepSummariesQuery) =>
      call<ApiSchema<"SleepSummariesResponse">>((headers) =>
        rawClient.GET("/api/v1/sleep/summaries", {
          headers,
          params: { query },
        }),
      ),

    getLatestSleepSummary: (query: SleepSummaryLatestQuery) =>
      call<ApiSchema<"SleepSummaryLatestResponse">>((headers) =>
        rawClient.GET("/api/v1/sleep/summaries/latest", {
          headers,
          params: { query },
        }),
      ),

    getLatestBodyMeasurement: (query: LatestBodyMeasurementQuery) =>
      call<ApiSchema<"BodyMeasurementLatestResponse">>((headers) =>
        rawClient.GET("/api/v1/body/measurements/latest", {
          headers,
          params: { query },
        }),
      ),

    listBodyMeasurements: (query: BodyMeasurementsQuery) =>
      call<ApiSchema<"BodyMeasurementsResponse">>((headers) =>
        rawClient.GET("/api/v1/body/measurements", {
          headers,
          params: { query },
        }),
      ),
    getDashboardSummary: (query: DashboardSummaryQuery) =>
      call<ApiSchema<"DashboardSummaryResponse">>((headers) =>
        rawClient.GET("/api/v1/dashboard/summary", {
          headers,
          params: { query },
        }),
      ),
    getDashboardTrends: (query: DashboardTrendsQuery) =>
      call<ApiSchema<"DashboardTrendsResponse">>((headers) =>
        rawClient.GET("/api/v1/dashboard/trends", {
          headers,
          params: { query },
        }),
      ),

    listBloodPressure: (query: LooseQuery) =>
      call<BloodPressureMeasurementsResponse>(
        (headers) => fetchJson(`${apiBaseUrl}/api/v1/metrics/blood-pressure${queryString(query)}`, { headers }),
      ),

    getLatestBloodPressure: (query: LooseQuery) =>
      call<BloodPressureLatestResponse>(
        (headers) => fetchJson(`${apiBaseUrl}/api/v1/metrics/blood-pressure/latest${queryString(query)}`, { headers }),
      ),

    listCardiovascular: (query: LooseQuery) =>
      call<CardiovascularMeasurementsResponse>(
        (headers) => fetchJson(`${apiBaseUrl}/api/v1/metrics/cardiovascular${queryString(query)}`, { headers }),
      ),

    getLatestCardiovascular: (query: LooseQuery) =>
      call<CardiovascularMeasurementResponse>(
        (headers) => fetchJson(`${apiBaseUrl}/api/v1/metrics/cardiovascular/latest${queryString(query)}`, { headers }),
      ),

    listExtendedBodyMeasurements: (query: LooseQuery) =>
      call<ExtendedBodyMeasurementsResponse>(
        (headers) => fetchJson(`${apiBaseUrl}/api/v1/metrics/extended-body-measurements${queryString(query)}`, { headers }),
      ),

    getLatestExtendedBodyMeasurement: (query: LooseQuery) =>
      call<ExtendedBodyMeasurementResponse>(
        (headers) => fetchJson(`${apiBaseUrl}/api/v1/metrics/extended-body-measurements/latest${queryString(query)}`, { headers }),
      ),
  };
}

type LooseQuery = Record<string, string | boolean | number | undefined>;

function queryString(query: LooseQuery): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, String(value));
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function fetchJson<T>(
  input: string,
  init: RequestInit,
  timeoutMs = backendRequestTimeoutMs,
): Promise<ClientResponse<T>> {
  const response = await fetchWithTimeout(input, init, timeoutMs);
  const body = await response.json().catch(() => undefined);
  return response.ok
    ? { data: body as T, response }
    : { error: body, response };
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = backendRequestTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
      next: { revalidate: 0 },
    } as RequestInit & { next: { revalidate: 0 } });
  } finally {
    clearTimeout(timeout);
  }
}

async function call<T>(
  execute: (headers: HeadersInit) => Promise<ClientResponse<T>>,
  options: ClientOptions = { protected: true },
): Promise<ApiResult<T>> {
  const headers: HeadersInit = {};

  if (options.protected) {
    const apiKey = process.env.AQT_HEALTH_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        message: "AQT_HEALTH_API_KEY is not configured for protected backend requests.",
      };
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const { data, error, response } = await execute(headers);

    if (!response?.ok || error) {
      return {
        ok: false,
        status: response?.status,
        message: errorMessage(error, response?.statusText ?? "Backend returned an error."),
      };
    }

    return {
      ok: true,
      data: data as T,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Backend request failed.",
    };
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: { message?: unknown; code?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
    if (typeof error?.code === "string") return error.code;
  }

  if (typeof body === "string" && body.trim()) return body;
  return fallback || "Backend returned an error.";
}
