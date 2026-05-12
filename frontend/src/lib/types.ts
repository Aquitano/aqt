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

export type GoogleHealthSyncRequest = {
  from?: string;
  to?: string;
  dataTypes?: string[];
  pageSize?: number;
};

export type GoogleHealthSyncResponse = {
  provider: string;
  providerInstanceId: string;
  requestedRange: {
    from: string;
    to: string;
  };
  batches: GoogleHealthSyncBatch[];
  errors: GoogleHealthSyncError[];
};

export type GoogleHealthSyncBatch = {
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
  metricsSkipped: {
    duplicates: number;
  };
  affectedStepSummaryDates: string[];
};

export type GoogleHealthSyncError = {
  dataType: string;
  code: string;
  message: string;
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
};
