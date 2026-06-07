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
export type ActivitySummary = ApiSchema<"ActivitySummaryResponse">;
export type ActivitySummariesResponse = ApiSchema<"ActivitySummariesResponse">;
export type ActivitySummaryLatestResponse = ApiSchema<"ActivitySummaryLatestResponse">;
export type HeartRateSample = ApiSchema<"HeartRateSampleResponse">;
export type HeartRateSamplesResponse = ApiSchema<"HeartRateSamplesResponse">;
export type HeartRateSummaryResponse = ApiSchema<"HeartRateSummaryResponse">;
export type RespiratoryRateSample = ApiSchema<"RespiratoryRateSampleResponse">;
export type RespiratoryRateSamplesResponse = ApiSchema<"RespiratoryRateSamplesResponse">;
export type RespiratoryRateSummaryResponse = ApiSchema<"RespiratoryRateSummaryResponse">;
export type HrvSample = ApiSchema<"HrvSampleResponse">;
export type HrvSamplesResponse = ApiSchema<"HrvSamplesResponse">;
export type HrvSummaryResponse = ApiSchema<"HrvSummaryResponse">;
export type SleepStage = ApiSchema<"SleepStageResponse">;
export type SleepSession = ApiSchema<"SleepSessionResponse">;
export type SleepSessionsResponse = ApiSchema<"SleepSessionsResponse">;
export type SleepSummary = ApiSchema<"SleepSummaryResponse">;
export type SleepSummariesResponse = ApiSchema<"SleepSummariesResponse">;
export type SleepSummaryLatestResponse = ApiSchema<"SleepSummaryLatestResponse">;
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
export type ProviderAccountListResponse = ApiSchema<"ProviderAccountListResponseDto">;
export type ProviderDisconnectResponse = ApiSchema<"ProviderDisconnectResponseDto">;
export type ProviderSyncRequest = ApiSchema<"ProviderSyncRequestDto">;
export type ProviderSyncResponse = ApiSchema<"ProviderSyncResponseDto">;
export type ProviderSyncBatch = ApiSchema<"ProviderSyncBatchResponseDto">;
export type ProviderSyncError = ApiSchema<"ProviderSyncErrorResponseDto">;
export type ProviderSyncEmptyDataType = ApiSchema<"ProviderSyncEmptyDataTypeResponseDto">;
export type ProviderSyncJobStartResponse = {
  jobId: string;
  status: string;
  createdAt: string;
};
export type ProviderSyncJobItem = {
  dataType: string;
  from: string;
  to: string;
};
export type ProviderSyncJobStatusResponse = {
  jobId: string;
  providerCode: string;
  providerInstanceId?: string | null;
  requestedFrom: string;
  requestedTo: string;
  dataTypes?: string[] | null;
  status: string;
  totalItems: number;
  completedItems: number;
  currentItem?: ProviderSyncJobItem | null;
  lastCompletedItem?: ProviderSyncJobItem | null;
  batchesCount: number;
  emptyCount: number;
  errorCount: number;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  updatedAt: string;
  finishedAt?: string | null;
  summary?: ProviderSyncResponse | null;
};
export type ProviderStatusCatalogResponse = ApiSchema<"ProviderStatusCatalogResponseDto">;
export type ProviderStatus = ApiSchema<"ProviderStatusResponseDto">;
export type ProviderAccountStatus = ApiSchema<"ProviderAccountStatusResponseDto">;
export type ScheduledSyncConfigUpdateRequest = ApiSchema<"ScheduledSyncConfigUpdateRequestDto">;
export type ScheduledSyncCheckpoint = ApiSchema<"ScheduledSyncCheckpointResponseDto">;
export type ScheduledSyncConfig = ApiSchema<"ScheduledSyncConfigResponseDto">;
export type ScheduledSyncRunResponse = ApiSchema<"ScheduledSyncRunResponseDto">;
export type MetricCatalogResponse = ApiSchema<"MetricCatalogResponseDto">;
export type MetricFamilyCatalog = ApiSchema<"MetricFamilyCatalogDto">;
export type MetricReadEndpoint = ApiSchema<"MetricReadEndpointDto">;
export type MetricQueryParameter = ApiSchema<"MetricQueryParameterDto">;
export type MetricAggregationMode = ApiSchema<"MetricAggregationModeDto">;
export type MetricProviderDataTypes = ApiSchema<"MetricProviderDataTypesDto">;
export type DashboardTrendsResponse = ApiSchema<"DashboardTrendsResponse">;

// New expanded metric types (will be part of generated API after codegen)
// New expanded metric types
export interface BloodPressureMeasurement {
  id: number;
  measuredAt: string;
  systolicMmhg: number;
  diastolicMmhg: number;
  heartRateBpm?: number | null;
  source?: SourceMetadata | null;
}
export interface BloodPressureMeasurementsResponse {
  items: BloodPressureMeasurement[];
  meta: ReadResponseMeta;
}
export interface BloodPressureLatestResponse {
  item?: BloodPressureMeasurement | null;
}

export interface CardiovascularMeasurement {
  id: number;
  measuredAt: string;
  metricType: string;
  value: number;
  unit: string;
  source?: SourceMetadata | null;
}
export interface CardiovascularMeasurementsResponse {
  items: CardiovascularMeasurement[];
  meta: ReadResponseMeta;
}

export interface CardiovascularMeasurementResponse {
  item?: CardiovascularMeasurement | null;
}

export interface ExtendedBodyMeasurement {
  id: number;
  measuredAt: string;
  metricType: string;
  value: number;
  unit: string;
  segment?: string | null;
  source?: SourceMetadata | null;
}
export interface ExtendedBodyMeasurementsResponse {
  items: ExtendedBodyMeasurement[];
  meta: ReadResponseMeta;
}

export interface ExtendedBodyMeasurementResponse {
  item?: ExtendedBodyMeasurement | null;
}

export type HealthDayModuleName = HealthDayResponse["modules"][number];
export type HealthStatusData = {
  apiBaseUrl: string;
  health: ApiResult<HealthResponse>;
};

export type HealthDataPageData = HealthStatusData & {
  summary: ApiResult<DashboardSummaryResponse>;
  trends: ApiResult<DashboardTrendsResponse>;
  healthDay: ApiResult<HealthDayResponse>;
  dailySteps: ApiResult<StepDailySummariesResponse>;
  activitySummaries: ApiResult<ActivitySummariesResponse>;
  bodyMeasurements: ApiResult<BodyMeasurementsResponse>;
  latestHeartRate: ApiResult<HeartRateSamplesResponse>;
  latestSleep: ApiResult<SleepNightsResponse>;
  sleepSummaries: ApiResult<SleepSummariesResponse>;
  respiratoryRates: ApiResult<RespiratoryRateSamplesResponse>;
  hrvSamples: ApiResult<HrvSamplesResponse>;
  latestActivity: ApiResult<ActivitySummaryLatestResponse>;
  latestSleepSummary: ApiResult<SleepSummaryLatestResponse>;
  latestRespiratoryRate: ApiResult<RespiratoryRateSamplesResponse>;
  latestHrv: ApiResult<HrvSamplesResponse>;
  bloodPressure: ApiResult<BloodPressureMeasurementsResponse>;
  latestBloodPressure: ApiResult<BloodPressureLatestResponse>;
  cardiovascular: ApiResult<CardiovascularMeasurementsResponse>;
  latestCardiovascular: ApiResult<CardiovascularMeasurementResponse>;
  extendedBodyMeasurements: ApiResult<ExtendedBodyMeasurementsResponse>;
  latestExtendedBodyMeasurement: ApiResult<ExtendedBodyMeasurementResponse>;
  metricCatalog: ApiResult<MetricCatalogResponse>;
};

export type ProviderSyncPageData = HealthStatusData & {
  providerCatalog: ApiResult<ProviderCatalogResponse>;
  providerStatuses: ApiResult<ProviderStatusCatalogResponse>;
  scheduledSyncConfigs: ApiResult<ScheduledSyncConfig>[];
};

export type IngestionsPageData = HealthStatusData & {
  batches: ApiResult<IngestionBatchesResponse>;
  failures: ApiResult<IngestionBatchesResponse>;
};
