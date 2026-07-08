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
export type ScalarSample = ApiSchema<"ScalarSampleResponse">;
export type ScalarSamplesResponse = ApiSchema<"ScalarSamplesResponse">;
export type BodyMeasurement = ScalarSample;
export type BodyMeasurementsResponse = ScalarSamplesResponse;
export type BodyMeasurementLatestResponse = ScalarSamplesResponse;
export type ActivitySummary = ApiSchema<"ActivitySummaryResponse">;
export type ActivitySummariesResponse = ApiSchema<"ActivitySummariesResponse">;
export type ActivitySummaryLatestResponse = ActivitySummariesResponse;
export type HeartRateSample = ScalarSample;
export type HeartRateSamplesResponse = ScalarSamplesResponse;
export type HeartRateSummaryResponse = ApiSchema<"ScalarSummaryResponse">;
export type RespiratoryRateSample = ScalarSample;
export type RespiratoryRateSamplesResponse = ScalarSamplesResponse;
export type RespiratoryRateSummaryResponse = ApiSchema<"ScalarSummaryResponse">;
export type HrvSample = ScalarSample;
export type HrvSamplesResponse = ScalarSamplesResponse;
export type HrvSummaryResponse = ApiSchema<"ScalarSummaryResponse">;
export type SleepStage = ApiSchema<"SleepStageResponse">;
export type SleepSession = ApiSchema<"SleepSessionResponse">;
export type SleepSessionsResponse = ApiSchema<"SleepSessionsResponse">;
export type SleepSummary = ApiSchema<"SleepSummaryResponse">;
export type SleepSummariesResponse = ApiSchema<"SleepSummariesResponse">;
export type SleepSummaryLatestResponse = SleepSummariesResponse;
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
export type MetricCatalogResponse = ApiSchema<"MetricTypeCatalogResponse">;
export type DashboardTrendsResponse = ApiSchema<"DashboardTrendsResponse">;

// New expanded metric types (will be part of generated API after codegen)
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
export type BloodPressureLatestResponse = BloodPressureMeasurementsResponse;

export type CardiovascularMeasurement = ScalarSample;
export type CardiovascularMeasurementsResponse = ScalarSamplesResponse;

export type CardiovascularMeasurementResponse = ScalarSamplesResponse;

export type ExtendedBodyMeasurement = ScalarSample;
export type ExtendedBodyMeasurementsResponse = ScalarSamplesResponse;

export type ExtendedBodyMeasurementResponse = ScalarSamplesResponse;

export type HealthDayModuleName = HealthDayResponse["modules"][number];
export type HealthStatusData = {
  apiBaseUrl: string;
  health: ApiResult<HealthResponse>;
};

export type HeartRateDailyPoint = {
  date: string;
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
};

export type HealthDataPageData = HealthStatusData & {
  summary: ApiResult<DashboardSummaryResponse>;
  trends: ApiResult<DashboardTrendsResponse>;
  healthDay: ApiResult<HealthDayResponse>;
  dailySteps: ApiResult<StepDailySummariesResponse>;
  activitySummaries: ApiResult<ActivitySummariesResponse>;
  bodyMeasurements: ApiResult<BodyMeasurementsResponse>;
  latestHeartRate: ApiResult<HeartRateSamplesResponse>;
  heartRateDaily: HeartRateDailyPoint[];
  sleepNights: ApiResult<SleepNightsResponse>;
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

/**
 * The page data with each field left as an unresolved promise, so the route can
 * fire every request up front and stream sections in as their own data settles
 * rather than blocking first paint on the slowest fetch.
 */
export type HealthDataPageSources = {
  [K in keyof HealthDataPageData]: K extends "apiBaseUrl"
    ? HealthDataPageData[K]
    : Promise<HealthDataPageData[K]>;
};

export type TrendsPageData = HealthStatusData & {
  fromDate: string;
  toDate: string;
  weight: ApiResult<BodyMeasurementsResponse>;
  steps: ApiResult<StepDailySummariesResponse>;
  sleep: ApiResult<SleepSummariesResponse>;
  hrv: ApiResult<HrvSamplesResponse>;
  activity: ApiResult<ActivitySummariesResponse>;
  respiratory: ApiResult<RespiratoryRateSamplesResponse>;
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
