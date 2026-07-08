import createClient from "openapi-fetch";
import type {
  ApiResult,
  ApiSchema,
  BloodPressureMeasurementsResponse,
  ExtendedBodyMeasurementResponse,
  ProviderSyncJobStartResponse,
  ProviderSyncJobStatusResponse,
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
type AqtOpenApiClient = ReturnType<typeof createClient<paths>>;

type IngestionBatchQuery = NonNullable<
  paths["/api/v2/admin/ingestion/batches"]["get"]["parameters"]["query"]
>;
type IngestionFailuresQuery = NonNullable<
  paths["/api/v2/admin/ingestion/failures"]["get"]["parameters"]["query"]
>;
type ProviderPathCode =
  paths["/api/v2/providers/{providerCode}/sync"]["post"]["parameters"]["path"]["providerCode"];
type HealthDayQuery = NonNullable<paths["/api/v2/health/day"]["get"]["parameters"]["query"]>;
type DailyStepsQuery = NonNullable<
  paths["/api/v2/steps/daily"]["get"]["parameters"]["query"]
>;
type ActivitySummariesQuery = NonNullable<
  paths["/api/v2/activity/summaries"]["get"]["parameters"]["query"]
>;
type ScalarSamplesQuery = NonNullable<
  paths["/api/v2/metrics/{metricType}"]["get"]["parameters"]["query"]
>;
type ScalarSummaryQuery = NonNullable<
  paths["/api/v2/metrics/{metricType}/summary"]["get"]["parameters"]["query"]
>;
type ScalarDailySummariesQuery = NonNullable<
  paths["/api/v2/metrics/{metricType}/daily"]["get"]["parameters"]["query"]
>;
type SleepNightsQuery = NonNullable<paths["/api/v2/sleep/nights"]["get"]["parameters"]["query"]>;
type SleepSummariesQuery = NonNullable<
  paths["/api/v2/sleep/summaries"]["get"]["parameters"]["query"]
>;
type DashboardSummaryQuery = NonNullable<
  paths["/api/v2/dashboard/summary"]["get"]["parameters"]["query"]
>;
type DashboardTrendsQuery = NonNullable<
  paths["/api/v2/dashboard/trends"]["get"]["parameters"]["query"]
>;
type BloodPressureQuery = NonNullable<
  paths["/api/v2/blood-pressure"]["get"]["parameters"]["query"]
>;

const bodyMetricTypes = ["weight", "body_fat", "muscle", "water", "visceral_fat"];
const cardiovascularMetricTypes = ["pulse_wave_velocity", "vascular_age", "standing_heart_rate"];
const extendedBodyMetricTypes = [
  "fat_mass",
  "fat_free_mass",
  "bone_mass",
  "intracellular_water",
  "extracellular_water",
  "basal_metabolic_rate",
  "segmental_fat_mass",
  "segmental_muscle_mass",
  "segmental_fat_free_mass",
];

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
      call<ApiSchema<"HealthResponse">>(() => rawClient.GET("/api/v2/admin/health"), {
        protected: false,
      }),

    listIngestionBatches: (query: IngestionBatchQuery) =>
      call<ApiSchema<"IngestionBatchesResponse">>(
        (headers) =>
          rawClient.GET("/api/v2/admin/ingestion/batches", {
            headers,
            params: { query },
          }),
      ),

    getIngestionBatch: (id: number) =>
      call<ApiSchema<"IngestionBatchDetailResponse">>(
        (headers) =>
          rawClient.GET("/api/v2/admin/ingestion/batches/{id}", {
            headers,
            params: { path: { id } },
          }),
      ),

    listIngestionFailures: (query: IngestionFailuresQuery) =>
      call<ApiSchema<"IngestionBatchesResponse">>(
        (headers) =>
          rawClient.GET("/api/v2/admin/ingestion/failures", {
            headers,
            params: { query },
          }),
      ),

    listProviders: () =>
      call<ApiSchema<"ProviderCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v2/providers", { headers }),
      ),

    listProviderStatuses: () =>
      call<ApiSchema<"ProviderStatusCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v2/providers/status", { headers }),
      ),

    startProviderOAuth: (providerCode: string) =>
      call<ApiSchema<"ProviderOAuthStartResponse">>((headers) =>
        rawClient.GET("/api/v2/providers/{providerCode}/oauth/start", {
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    listProviderAccounts: (providerCode: string) =>
      call<ApiSchema<"ProviderAccountListResponseDto">>((headers) =>
        rawClient.GET("/api/v2/providers/{providerCode}/accounts", {
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    getProviderAccount: (providerCode: string, providerInstanceId: string) =>
      call<ApiSchema<"ProviderAccountStatusResponseDto">>((headers) =>
        rawClient.GET("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}", {
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
        rawClient.POST("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/disconnect", {
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
        rawClient.POST("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/reconnect", {
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
        rawClient.GET("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync", {
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
        rawClient.PUT("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync", {
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
        longRunningClient.POST("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync/run", {
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
        longRunningClient.POST("/api/v2/providers/{providerCode}/sync", {
          body,
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    startProviderSyncJob: (
      providerCode: string,
      body: ApiSchema<"ProviderSyncRequestDto">,
    ) =>
      call<ProviderSyncJobStartResponse>((headers) =>
        fetchJson(`${apiBaseUrl}/api/v2/providers/${encodeURIComponent(providerCode)}/sync-jobs`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),

    getProviderSyncJob: (
      providerCode: string,
      jobId: string,
    ) =>
      call<ProviderSyncJobStatusResponse>((headers) =>
        fetchJson(
          `${apiBaseUrl}/api/v2/providers/${encodeURIComponent(providerCode)}/sync-jobs/${encodeURIComponent(jobId)}`,
          { headers },
        ),
      ),

    getMetricCatalog: () =>
      call<ApiSchema<"MetricTypeCatalogResponse">>((headers) =>
        rawClient.GET("/api/v2/metrics", { headers }),
      ),

    getHealthDay: (query: HealthDayQuery) =>
      call<ApiSchema<"HealthDayResponse">>((headers) =>
        rawClient.GET("/api/v2/health/day", {
          headers,
          params: { query },
        }),
      ),

    listDailyStepSummaries: (query: DailyStepsQuery) =>
      call<ApiSchema<"StepDailySummariesResponse">>((headers) =>
        rawClient.GET("/api/v2/steps/daily", {
          headers,
          params: { query },
        }),
      ),

    listActivitySummaries: (query: ActivitySummariesQuery) =>
      call<ApiSchema<"ActivitySummariesResponse">>((headers) =>
        rawClient.GET("/api/v2/activity/summaries", {
          headers,
          params: { query },
        }),
      ),

    getLatestActivitySummary: (query: ActivitySummariesQuery) =>
      call<ApiSchema<"ActivitySummariesResponse">>((headers) =>
        rawClient.GET("/api/v2/activity/summaries", {
          headers,
          params: { query: { ...query, latest: true } },
        }),
      ),

    listHeartRateSamples: (query: ScalarSamplesQuery) =>
      listScalarMetric(rawClient, "heart_rate", query),

    getScalarSummary: (metricType: string, query: ScalarSummaryQuery) =>
      call<ApiSchema<"ScalarSummaryResponse">>((headers) =>
        rawClient.GET("/api/v2/metrics/{metricType}/summary", {
          headers,
          params: { path: { metricType }, query },
        }),
      ),

    getScalarDailySummaries: (metricType: string, query: ScalarDailySummariesQuery) =>
      call<ApiSchema<"ScalarDailySummariesResponse">>((headers) =>
        rawClient.GET("/api/v2/metrics/{metricType}/daily", {
          headers,
          params: { path: { metricType }, query },
        }),
      ),

    listRespiratoryRateSamples: (query: ScalarSamplesQuery) =>
      listScalarMetric(rawClient, "respiratory_rate", query),

    listHrvSamples: (query: ScalarSamplesQuery) =>
      listScalarMetric(rawClient, "hrv_rmssd", query),

    listSleepNights: (query: SleepNightsQuery) =>
      call<ApiSchema<"SleepNightsResponse">>((headers) =>
        rawClient.GET("/api/v2/sleep/nights", {
          headers,
          params: { query },
        }),
      ),

    listSleepSummaries: (query: SleepSummariesQuery) =>
      call<ApiSchema<"SleepSummariesResponse">>((headers) =>
        rawClient.GET("/api/v2/sleep/summaries", {
          headers,
          params: { query },
        }),
      ),

    getLatestSleepSummary: (query: SleepSummariesQuery) =>
      call<ApiSchema<"SleepSummariesResponse">>((headers) =>
        rawClient.GET("/api/v2/sleep/summaries", {
          headers,
          params: { query: { ...query, latest: true } },
        }),
      ),

    getLatestBodyMeasurement: (query: ScalarSamplesQuery) =>
      listScalarMetric(rawClient, "weight", { ...query, latest: true }),

    listBodyMeasurements: (query: ScalarSamplesQuery) =>
      listScalarMetrics(rawClient, bodyMetricTypes, query),
    getDashboardSummary: (query: DashboardSummaryQuery) =>
      call<ApiSchema<"DashboardSummaryResponse">>((headers) =>
        rawClient.GET("/api/v2/dashboard/summary", {
          headers,
          params: { query },
        }),
      ),
    getDashboardTrends: (query: DashboardTrendsQuery) =>
      call<ApiSchema<"DashboardTrendsResponse">>((headers) =>
        rawClient.GET("/api/v2/dashboard/trends", {
          headers,
          params: { query },
        }),
      ),

    listBloodPressure: (query: BloodPressureQuery) =>
      call<BloodPressureMeasurementsResponse>((headers) =>
        rawClient.GET("/api/v2/blood-pressure", {
          headers,
          params: { query },
        }),
      ),

    getLatestBloodPressure: (query: BloodPressureQuery) =>
      call<BloodPressureMeasurementsResponse>((headers) =>
        rawClient.GET("/api/v2/blood-pressure", {
          headers,
          params: { query: { ...query, latest: true } },
        }),
      ),

    listCardiovascular: (query: ScalarSamplesQuery) =>
      listScalarMetrics(rawClient, cardiovascularMetricTypes, query),

    getLatestCardiovascular: (query: ScalarSamplesQuery) =>
      listScalarMetrics(rawClient, cardiovascularMetricTypes, { ...query, latest: true }),

    listExtendedBodyMeasurements: (query: ScalarSamplesQuery) =>
      listScalarMetrics(rawClient, extendedBodyMetricTypes, query),

    getLatestExtendedBodyMeasurement: (query: ScalarSamplesQuery) =>
      listScalarMetrics(rawClient, extendedBodyMetricTypes, { ...query, latest: true }) as Promise<
        ApiResult<ExtendedBodyMeasurementResponse>
      >,
  };
}

function listScalarMetric(
  client: AqtOpenApiClient,
  metricType: string,
  query: ScalarSamplesQuery,
): Promise<ApiResult<ApiSchema<"ScalarSamplesResponse">>> {
  return call<ApiSchema<"ScalarSamplesResponse">>((headers) =>
    client.GET("/api/v2/metrics/{metricType}", {
      headers,
      params: { path: { metricType }, query },
    }),
  );
}

function listScalarMetrics(
  client: AqtOpenApiClient,
  metricTypes: string[],
  query: ScalarSamplesQuery,
): Promise<ApiResult<ApiSchema<"ScalarSamplesResponse">>> {
  return call<ApiSchema<"ScalarSamplesResponse">>((headers) =>
    mergedScalarMetrics(client, metricTypes, query, headers),
  );
}

async function mergedScalarMetrics(
  client: AqtOpenApiClient,
  metricTypes: string[],
  query: ScalarSamplesQuery,
  headers: HeadersInit,
): Promise<ClientResponse<ApiSchema<"ScalarSamplesResponse">>> {
  const responses = await Promise.all(
    metricTypes.map((metricType) =>
      client.GET("/api/v2/metrics/{metricType}", {
        headers,
        params: { path: { metricType }, query },
      }),
    ),
  );
  const failed = responses.find((result) => result.error || !result.response?.ok);
  if (failed) return failed as ClientResponse<ApiSchema<"ScalarSamplesResponse">>;

  const order = query.order ?? (query.latest ? "desc" : "asc");
  const requestedLimit = query.limit ?? 500;
  const mergedItems = responses
    .flatMap((result) => result.data?.items ?? [])
    .sort((left, right) => {
      const measured = left.measuredAt.localeCompare(right.measuredAt);
      const byTime = order === "desc" ? -measured : measured;
      if (byTime !== 0) return byTime;
      return order === "desc" ? right.id - left.id : left.id - right.id;
    });
  const items = query.latest ? mergedItems : mergedItems.slice(0, requestedLimit);
  const firstMeta = responses[0]?.data?.meta;

  return {
    data: {
      items,
      meta: {
        count: items.length,
        limit: requestedLimit,
        sort: firstMeta?.sort ?? "measuredAt",
        order,
      },
    },
    response: responses[0]?.response,
  };
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
