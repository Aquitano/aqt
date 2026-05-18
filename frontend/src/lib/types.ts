export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string };

export type HealthResponse = {
  status: string;
  service: string;
  time: string;
};

export type SourceMetadata = {
  provider: string;
  providerInstanceId: string;
};

export type ReadResponseMeta = {
  count: number;
  limit: number;
  sort: string;
  order: string;
  nextCursor?: string;
};

export type StepDailySummary = {
  date: string;
  steps: number;
  sampleCount: number;
  source?: SourceMetadata;
};

export type StepDailySummariesResponse = {
  items: StepDailySummary[];
  meta: ReadResponseMeta;
};

export type BodyMeasurement = {
  id: number;
  measuredAt: string;
  metricType: string;
  value: number;
  unit: string;
  source?: SourceMetadata;
};

export type BodyMeasurementsResponse = {
  items: BodyMeasurement[];
  meta: ReadResponseMeta;
};

export type BodyMeasurementLatestResponse = {
  item?: BodyMeasurement;
};

export type HeartRateSample = {
  id: number;
  measuredAt: string;
  bpm: number;
  context: string;
  source?: SourceMetadata;
};

export type HeartRateSamplesResponse = {
  items: HeartRateSample[];
  meta: ReadResponseMeta;
};

export type HeartRateSummaryResponse = {
  count: number;
  minBpm?: number;
  maxBpm?: number;
  avgBpm?: number;
  latest?: HeartRateSample;
};

export type SleepStage = {
  stage: string;
  startAt: string;
  endAt: string;
  durationSeconds: number;
};

export type SleepSession = {
  id: number;
  startAt: string;
  endAt: string;
  durationSeconds: number;
  stages: SleepStage[];
  source?: SourceMetadata;
};

export type SleepSessionsResponse = {
  items: SleepSession[];
  meta: ReadResponseMeta;
};

export type SleepNight = {
  date: string;
  timezone: string;
  session: SleepSession;
};

export type SleepNightsResponse = {
  items: SleepNight[];
  meta: ReadResponseMeta;
};

export type DashboardSummaryResponse = {
  fromDate: string;
  toDate: string;
  steps: {
    steps: number;
    sampleCount: number;
  };
  latestWeight?: BodyMeasurement;
  latestHeartRate?: HeartRateSample;
  lastSleepSession?: SleepSession;
};

export type HealthDayModuleName = "steps" | "heartRate" | "weight" | "sleep";

export type HealthDayBucket = {
  startAt: string;
  endAt: string;
  value?: number;
  count: number;
};

export type HealthDayResponse = {
  date: string;
  timezone: string;
  from: string;
  to: string;
  modules: HealthDayModuleName[];
  steps?: {
    total: number;
    sampleCount: number;
    buckets: HealthDayBucket[];
  };
  heartRate?: {
    count: number;
    minBpm?: number;
    maxBpm?: number;
    avgBpm?: number;
    latest?: HeartRateSample;
    buckets: HealthDayBucket[];
  };
  weight?: {
    latest?: BodyMeasurement;
    previous?: BodyMeasurement;
    delta?: number;
    points: BodyMeasurement[];
  };
  sleep?: {
    totalDurationSeconds: number;
    sessions: SleepSession[];
    stageTotals: Array<{
      stage: string;
      durationSeconds: number;
    }>;
    timeline: Array<{
      stage: string;
      startAt: string;
      endAt: string;
    }>;
  };
};

export type IngestionBatch = {
  id: number;
  provider: string;
  providerInstanceId: string;
  batchExternalId?: string;
  status: string;
  ingestedAt: string;
  receivedAt: string;
  processedAt?: string;
  errorMessage?: string;
  recordCount: number;
};

export type IngestionBatchesResponse = {
  items: IngestionBatch[];
};

export type IngestionRecordAdmin = {
  id: number;
  recordType: string;
  providerRecordId?: string;
  recordStartAt?: string;
  recordEndAt?: string;
  createdAt: string;
  normalizedRecord?: unknown;
};

export type IngestionBatchDetailResponse = IngestionBatch & {
  records: IngestionRecordAdmin[];
  sourcePayload?: unknown;
  normalizedPayload?: unknown;
};

export type ProviderCatalogResponse = {
  providers: ProviderDescriptor[];
};

export type ProviderDescriptor = {
  providerCode: string;
  displayName: string;
  authType: string;
  requiresAuthentication: boolean;
  supportedDataTypes: string[];
  defaultDataTypes: string[];
  maxSyncRangeDays: number;
  supportsPageSize: boolean;
  workflowEndpoints: ProviderWorkflowEndpoints;
  aliases: string[];
};

export type ProviderWorkflowEndpoints = {
  oauthStart?: string;
  oauthCallback?: string;
  sync: string;
};

export type ProviderOAuthStartResponse = {
  provider: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type ProviderSyncRequest = {
  from?: string;
  to?: string;
  dataTypes?: string[];
  pageSize?: number;
};

export type ProviderSyncResponse = {
  providerCode: string;
  providerInstanceId: string;
  requestedFrom: string;
  requestedTo: string;
  status: string;
  batches: ProviderSyncBatch[];
  emptyDataTypes: ProviderSyncEmptyDataType[];
  errors: ProviderSyncError[];
};

export type ProviderSyncBatch = {
  dataType: string;
  batchId: number;
  duplicateBatch: boolean;
  recordsReceived: number;
  ingestionRecordsStored: number;
  metricsCreated: {
    stepSamples: number;
    sleepSessions: number;
    sleepStages: number;
    bodyMeasurements: number;
    heartRateSamples: number;
  };
  duplicateMetricsSkipped: number;
  affectedStepSummaryDates: string[];
};

export type ProviderSyncError = {
  dataType: string;
  code: string;
  message: string;
};

export type ProviderSyncEmptyDataType = {
  dataType: string;
  pagesFetched: number;
  sourceRecordsReceived: number;
  normalizedRecords: number;
};

export type ProviderStatusCatalogResponse = {
  providers: ProviderStatus[];
};

export type MetricCatalogResponse = {
  families: MetricFamilyCatalog[];
};

export type MetricFamilyCatalog = {
  name: string;
  readEndpoints: MetricReadEndpoint[];
  queryParameters: MetricQueryParameter[];
  aggregationModes: MetricAggregationMode[];
  metricTypes: string[];
  responseDtos: string[];
  providerDataTypes: MetricProviderDataTypes[];
  schemaHint: string;
};

export type MetricReadEndpoint = {
  mode: string;
  method: "GET";
  path?: string;
  available: boolean;
  responseDto?: string;
};

export type MetricQueryParameter = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  values: string[];
};

export type MetricAggregationMode = {
  name: string;
  available: boolean;
  endpoint?: string;
};

export type MetricProviderDataTypes = {
  providerCode: string;
  dataTypes: string[];
};

export type ProviderStatus = {
  providerCode: string;
  displayName: string;
  configured: boolean;
  connected: boolean;
  needsAuthentication: boolean;
  canSync: boolean;
  nextAction: "configure" | "connect" | "reconnect" | "sync";
  accounts: ProviderAccountStatus[];
};

export type ProviderAccountStatus = {
  providerInstanceId: string;
  connectedAt: string;
  lastSyncAt?: string;
  tokenStatus: "valid" | "expired" | "missing" | "unknown";
  expiresAt?: string;
};

export type HealthStatusData = {
  apiBaseUrl: string;
  health: ApiResult<HealthResponse>;
};

export type HealthDataPageData = HealthStatusData & {
  summary: ApiResult<DashboardSummaryResponse>;
  healthDay: ApiResult<HealthDayResponse>;
  dailySteps: ApiResult<StepDailySummariesResponse>;
  latestWeight: ApiResult<BodyMeasurementLatestResponse>;
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
