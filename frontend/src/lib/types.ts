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
export type ProviderCatalogResponse = ApiSchema<"ProviderCatalogResponse">;
export type ProviderDescriptor = ApiSchema<"ProviderDescriptorResponse">;
export type ProviderWorkflowEndpoints = ApiSchema<"ProviderWorkflowEndpointsResponse">;
export type ProviderOAuthStartResponse = ApiSchema<"ProviderOAuthStartResponse">;
export type ProviderAccountListResponse = ApiSchema<"ProviderAccountListResponse">;
export type ProviderDisconnectResponse = ApiSchema<"ProviderDisconnectResponse">;
export type ProviderSyncRequest = ApiSchema<"ProviderSyncRequest">;
export type ProviderSyncResponse = ApiSchema<"ProviderSyncResponse">;
export type ProviderSyncBatch = ApiSchema<"ProviderSyncBatchResponse">;
export type ProviderSyncError = ApiSchema<"ProviderSyncErrorResponse">;
export type ProviderSyncEmptyDataType = ApiSchema<"ProviderSyncEmptyDataTypeResponse">;
export type ProviderSyncJobStartResponse = ApiSchema<"ProviderSyncJobStartResponse">;
export type ProviderSyncJobItem = ApiSchema<"ProviderSyncJobItemResponse">;
export type ProviderSyncJobStatusResponse = ApiSchema<"ProviderSyncJobStatusResponse">;
export type ProviderStatusCatalogResponse = ApiSchema<"ProviderStatusCatalogResponse">;
export type ProviderStatus = ApiSchema<"ProviderStatusResponse">;
export type ProviderAccountStatus = ApiSchema<"ProviderAccountStatusResponse">;
export type ScheduledSyncConfigUpdateRequest = ApiSchema<"ScheduledSyncConfigUpdateRequest">;
export type ScheduledSyncCheckpoint = ApiSchema<"ScheduledSyncCheckpointResponse">;
export type ScheduledSyncConfig = ApiSchema<"ScheduledSyncConfigResponse">;
export type ScheduledSyncRunResponse = ApiSchema<"ScheduledSyncRunResponse">;
export type MetricCatalogResponse = ApiSchema<"MetricTypeCatalogResponse">;
export type DashboardTrendsResponse = ApiSchema<"DashboardTrendsResponse">;

export type BloodPressureMeasurement = ApiSchema<"BloodPressureMeasurementResponse">;
export type BloodPressureMeasurementsResponse = ApiSchema<"BloodPressureMeasurementsResponse">;
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
