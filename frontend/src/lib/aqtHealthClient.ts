import createClient from "openapi-fetch";
import type { ApiResult } from "./types";
import type { components, paths } from "./generated/aqtHealthApiTypes";

export type AqtHealthSchema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];

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
type HeartRateSamplesQuery = NonNullable<
  paths["/api/v1/metrics/heart-rate"]["get"]["parameters"]["query"]
>;
type SleepNightsQuery = NonNullable<paths["/api/v1/sleep/nights"]["get"]["parameters"]["query"]>;
type LatestBodyMeasurementQuery = NonNullable<
  paths["/api/v1/body/measurements/latest"]["get"]["parameters"]["query"]
>;
type DashboardSummaryQuery = NonNullable<
  paths["/api/v1/dashboard/summary"]["get"]["parameters"]["query"]
>;

const defaultBaseUrl = "http://localhost:8080";

export function apiBaseUrlFromEnv(): string {
  return process.env.AQT_HEALTH_API_BASE_URL ?? defaultBaseUrl;
}

export function createAqtHealthClient() {
  const apiBaseUrl = apiBaseUrlFromEnv();
  const rawClient = createClient<paths>({
    baseUrl: apiBaseUrl,
    fetch: (input) =>
      fetch(input, {
        next: { revalidate: 0 },
      } as RequestInit & { next: { revalidate: 0 } }),
  });

  return {
    apiBaseUrl,

    getHealth: () =>
      call<AqtHealthSchema<"HealthResponse">>(() => rawClient.GET("/api/v1/admin/health"), {
        protected: false,
      }),

    listIngestionBatches: (query: IngestionBatchQuery) =>
      call<AqtHealthSchema<"IngestionBatchesResponse">>(
        (headers) =>
          rawClient.GET("/api/v1/admin/ingestion/batches", {
            headers,
            params: { query },
          }),
      ),

    getIngestionBatch: (id: number) =>
      call<AqtHealthSchema<"IngestionBatchDetailResponse">>(
        (headers) =>
          rawClient.GET("/api/v1/admin/ingestion/batches/{id}", {
            headers,
            params: { path: { id } },
          }),
      ),

    listIngestionFailures: (query: IngestionFailuresQuery) =>
      call<AqtHealthSchema<"IngestionBatchesResponse">>(
        (headers) =>
          rawClient.GET("/api/v1/admin/ingestion/failures", {
            headers,
            params: { query },
          }),
      ),

    listProviders: () =>
      call<AqtHealthSchema<"ProviderCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v1/providers", { headers }),
      ),

    listProviderStatuses: () =>
      call<AqtHealthSchema<"ProviderStatusCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v1/providers/status", { headers }),
      ),

    startProviderOAuth: (providerCode: string) =>
      call<AqtHealthSchema<"ProviderOAuthStartResponse">>((headers) =>
        rawClient.GET("/api/v1/providers/{providerCode}/oauth/start", {
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    syncProvider: (
      providerCode: string,
      body: AqtHealthSchema<"ProviderSyncRequestDto">,
    ) =>
      call<AqtHealthSchema<"ProviderSyncResponseDto">>((headers) =>
        rawClient.POST("/api/v1/providers/{providerCode}/sync", {
          body,
          headers,
          params: { path: { providerCode: providerCode as ProviderPathCode } },
        }),
      ),

    getMetricCatalog: () =>
      call<AqtHealthSchema<"MetricCatalogResponseDto">>((headers) =>
        rawClient.GET("/api/v1/metrics/catalog", { headers }),
      ),

    getHealthDay: (query: HealthDayQuery) =>
      call<AqtHealthSchema<"HealthDayResponse">>((headers) =>
        rawClient.GET("/api/v1/health/day", {
          headers,
          params: { query },
        }),
      ),

    listDailyStepSummaries: (query: DailyStepsQuery) =>
      call<AqtHealthSchema<"StepDailySummariesResponse">>((headers) =>
        rawClient.GET("/api/v1/metrics/steps/daily", {
          headers,
          params: { query },
        }),
      ),

    listHeartRateSamples: (query: HeartRateSamplesQuery) =>
      call<AqtHealthSchema<"HeartRateSamplesResponse">>((headers) =>
        rawClient.GET("/api/v1/metrics/heart-rate", {
          headers,
          params: { query },
        }),
      ),

    listSleepNights: (query: SleepNightsQuery) =>
      call<AqtHealthSchema<"SleepNightsResponse">>((headers) =>
        rawClient.GET("/api/v1/sleep/nights", {
          headers,
          params: { query },
        }),
      ),

    getLatestBodyMeasurement: (query: LatestBodyMeasurementQuery) =>
      call<AqtHealthSchema<"BodyMeasurementLatestResponse">>((headers) =>
        rawClient.GET("/api/v1/body/measurements/latest", {
          headers,
          params: { query },
        }),
      ),

    getDashboardSummary: (query: DashboardSummaryQuery) =>
      call<AqtHealthSchema<"DashboardSummaryResponse">>((headers) =>
        rawClient.GET("/api/v1/dashboard/summary", {
          headers,
          params: { query },
        }),
      ),
  };
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
