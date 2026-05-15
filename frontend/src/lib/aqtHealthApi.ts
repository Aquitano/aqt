import type {
  ApiResult,
  BodyMeasurementsResponse,
  DashboardData,
  DashboardSummaryResponse,
  HealthResponse,
  HeartRateSamplesResponse,
  IngestionBatchesResponse,
  ProviderCatalogResponse,
  ProviderOAuthStartResponse,
  ProviderStatusCatalogResponse,
  ProviderSyncRequest,
  ProviderSyncResponse,
  SleepSessionsResponse,
  StepDailySummariesResponse,
} from "./types";

type FetchOptions = {
  protected?: boolean;
  method?: "GET" | "POST";
  body?: unknown;
};

const defaultBaseUrl = "http://localhost:8080";

export async function getDashboardData(fromDate: string, toDate: string): Promise<DashboardData> {
  const apiBaseUrl = apiBaseUrlFromEnv();

  const [
    health,
    summary,
    dailySteps,
    latestWeight,
    latestHeartRate,
    latestSleep,
    batches,
    failures,
    providerCatalog,
    providerStatuses,
  ] = await Promise.all([
    request<HealthResponse>("/api/v1/admin/health"),
    request<DashboardSummaryResponse>(
      `/api/v1/dashboard/summary?${params({ fromDate, toDate })}`,
      { protected: true },
    ),
    request<StepDailySummariesResponse>(
      `/api/v1/metrics/steps/daily?${params({ fromDate, toDate, includeSource: "true" })}`,
      { protected: true },
    ),
    request<BodyMeasurementsResponse>(
      "/api/v1/body/measurements?metricType=weight&latest=true&includeSource=true",
      { protected: true },
    ),
    request<HeartRateSamplesResponse>(
      "/api/v1/metrics/heart-rate?latest=true&includeSource=true",
      { protected: true },
    ),
    request<SleepSessionsResponse>(
      "/api/v1/sleep/sessions?latest=true&includeSource=true",
      { protected: true },
    ),
    request<IngestionBatchesResponse>("/api/v1/admin/ingestion/batches?limit=10", {
      protected: true,
    }),
    request<IngestionBatchesResponse>("/api/v1/admin/ingestion/failures?limit=10", {
      protected: true,
    }),
    getProviderCatalog(),
    getProviderStatuses(),
  ]);

  return {
    apiBaseUrl,
    health,
    summary,
    dailySteps,
    latestWeight,
    latestHeartRate,
    latestSleep,
    batches,
    failures,
    providerCatalog,
    providerStatuses,
  };
}

export async function getProviderCatalog(): Promise<ApiResult<ProviderCatalogResponse>> {
  return request<ProviderCatalogResponse>("/api/v1/providers", {
    protected: true,
  });
}

export async function getProviderStatuses(): Promise<ApiResult<ProviderStatusCatalogResponse>> {
  return request<ProviderStatusCatalogResponse>("/api/v1/providers/status", {
    protected: true,
  });
}

export async function startProviderOAuth(
  providerCode: string,
): Promise<ApiResult<ProviderOAuthStartResponse>> {
  return request<ProviderOAuthStartResponse>(
    `/api/v1/providers/${encodeURIComponent(providerCode)}/oauth/start`,
    {
      protected: true,
    },
  );
}

export async function syncProvider(
  providerCode: string,
  payload: ProviderSyncRequest,
): Promise<ApiResult<ProviderSyncResponse>> {
  return request<ProviderSyncResponse>(`/api/v1/providers/${encodeURIComponent(providerCode)}/sync`, {
    protected: true,
    method: "POST",
    body: payload,
  });
}

function apiBaseUrlFromEnv(): string {
  return process.env.AQT_HEALTH_API_BASE_URL ?? defaultBaseUrl;
}

async function request<T>(path: string, options: FetchOptions = {}): Promise<ApiResult<T>> {
  const apiBaseUrl = apiBaseUrlFromEnv();
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

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetch(new URL(path, apiBaseUrl), {
      headers,
      method: options.method ?? "GET",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      next: { revalidate: 0 },
    });
    const text = await response.text();
    const body = parseJson(text);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: errorMessage(body, response.statusText),
      };
    }

    return {
      ok: true,
      data: body as T,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Backend request failed.",
    };
  }
}

function params(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
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
