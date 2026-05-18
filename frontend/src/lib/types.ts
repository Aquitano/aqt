import type { components } from "./generated/aqtHealthApiTypes";

export type ApiSchema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string };

export type HealthResponse = ApiSchema<"HealthResponse">;
export type SourceMetadata = ApiSchema<"SourceMetadataResponse">;
export type ReadResponseMeta = ApiSchema<"ReadResponseMeta">;
export type StepDailySummary = ApiSchema<"StepDailySummaryResponse">;
export type StepDailySummariesResponse = ApiSchema<"StepDailySummariesResponse">;
export type BodyMeasurement = ApiSchema<"BodyMeasurementResponse">;
export type BodyMeasurementsResponse = ApiSchema<"BodyMeasurementsResponse">;
export type BodyMeasurementLatestResponse = ApiSchema<"BodyMeasurementLatestResponse">;
export type HeartRateSample = ApiSchema<"HeartRateSampleResponse">;
export type HeartRateSamplesResponse = ApiSchema<"HeartRateSamplesResponse">;
export type HeartRateSummaryResponse = ApiSchema<"HeartRateSummaryResponse">;
export type SleepStage = ApiSchema<"SleepStageResponse">;
export type SleepSession = ApiSchema<"SleepSessionResponse">;
export type SleepSessionsResponse = ApiSchema<"SleepSessionsResponse">;
export type SleepNight = ApiSchema<"SleepNightResponse">;
export type SleepNightsResponse = ApiSchema<"SleepNightsResponse">;
export type DashboardSummaryResponse = ApiSchema<"DashboardSummaryResponse">;
export type HealthDayBucket = ApiSchema<"HealthDayBucketResponse">;
export type HealthDayResponse = ApiSchema<"HealthDayResponse">;
export type IngestionBatch = ApiSchema<"IngestionBatchAdminResponse">;
export type IngestionBatchesResponse = ApiSchema<"IngestionBatchesResponse">;
export type IngestionRecordAdmin = ApiSchema<"IngestionRecordAdminResponse">;
export type IngestionBatchDetailResponse = ApiSchema<"IngestionBatchDetailResponse">;
export type ProviderCatalogResponse = ApiSchema<"ProviderCatalogResponseDto">;
export type ProviderDescriptor = ApiSchema<"ProviderDescriptorResponseDto">;
export type ProviderWorkflowEndpoints = ApiSchema<"ProviderWorkflowEndpointsResponseDto">;
export type ProviderOAuthStartResponse = ApiSchema<"ProviderOAuthStartResponse">;
export type ProviderSyncRequest = ApiSchema<"ProviderSyncRequestDto">;
export type ProviderSyncResponse = ApiSchema<"ProviderSyncResponseDto">;
export type ProviderSyncBatch = ApiSchema<"ProviderSyncBatchResponseDto">;
export type ProviderSyncError = ApiSchema<"ProviderSyncErrorResponseDto">;
export type ProviderSyncEmptyDataType = ApiSchema<"ProviderSyncEmptyDataTypeResponseDto">;
export type ProviderStatusCatalogResponse = ApiSchema<"ProviderStatusCatalogResponseDto">;
export type ProviderStatus = ApiSchema<"ProviderStatusResponseDto">;
export type ProviderAccountStatus = ApiSchema<"ProviderAccountStatusResponseDto">;
export type MetricCatalogResponse = ApiSchema<"MetricCatalogResponseDto">;
export type MetricFamilyCatalog = ApiSchema<"MetricFamilyCatalogDto">;
export type MetricReadEndpoint = ApiSchema<"MetricReadEndpointDto">;
export type MetricQueryParameter = ApiSchema<"MetricQueryParameterDto">;
export type MetricAggregationMode = ApiSchema<"MetricAggregationModeDto">;
export type MetricProviderDataTypes = ApiSchema<"MetricProviderDataTypesDto">;

export type HealthDayModuleName = HealthDayResponse["modules"][number];

export type HealthStatusData = {
  apiBaseUrl: string;
  health: ApiResult<HealthResponse>;
};

export type HealthDataPageData = HealthStatusData & {
  summary: ApiResult<DashboardSummaryResponse>;
  healthDay: ApiResult<HealthDayResponse>;
  dailySteps: ApiResult<StepDailySummariesResponse>;
  bodyMeasurements: ApiResult<BodyMeasurementsResponse>;
  latestHeartRate: ApiResult<HeartRateSamplesResponse>;
  latestSleep: ApiResult<SleepNightsResponse>;
  metricCatalog: ApiResult<MetricCatalogResponse>;
};

export type ProviderSyncPageData = HealthStatusData & {
  providerCatalog: ApiResult<ProviderCatalogResponse>;
  providerStatuses: ApiResult<ProviderStatusCatalogResponse>;
};

export type IngestionsPageData = HealthStatusData & {
  batches: ApiResult<IngestionBatchesResponse>;
  failures: ApiResult<IngestionBatchesResponse>;
};
