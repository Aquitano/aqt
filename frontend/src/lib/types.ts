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

export type StepDailySummary = {
  date: string;
  steps: number;
  sampleCount: number;
  source?: SourceMetadata;
};

export type StepDailySummariesResponse = {
  items: StepDailySummary[];
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

export type DashboardData = {
  apiBaseUrl: string;
  health: ApiResult<HealthResponse>;
  summary: ApiResult<DashboardSummaryResponse>;
  dailySteps: ApiResult<StepDailySummariesResponse>;
  latestWeight: ApiResult<BodyMeasurementsResponse>;
  latestHeartRate: ApiResult<HeartRateSamplesResponse>;
  latestSleep: ApiResult<SleepSessionsResponse>;
  batches: ApiResult<IngestionBatchesResponse>;
  failures: ApiResult<IngestionBatchesResponse>;
  providerCatalog: ApiResult<ProviderCatalogResponse>;
  providerStatuses: ApiResult<ProviderStatusCatalogResponse>;
};
