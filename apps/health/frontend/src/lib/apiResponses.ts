import { type } from "arktype";
import type { ArkErrors } from "arktype";

import type {
  ApiResult,
  ProviderOAuthStartResponse,
  ProviderSyncJobStartResponse,
  ProviderSyncJobStatusResponse,
  ScheduledSyncRunResponse,
} from "./types";

/**
 * The browser reaches the backend through this app's route handlers, so every payload it reads
 * back is parsed here instead of being trusted for the type the handler declared.
 */

const apiFailure = type({ ok: "false", "status?": "number", message: "string" });

const providerSyncBatch = type({
  dataType: "string",
  batchId: "number",
  duplicateBatch: "boolean",
  recordsReceived: "number",
  ingestionRecordsStored: "number",
  metricsCreated: { "[string]": "number" },
  duplicateMetricsSkipped: "number",
  affectedStepSummaryDates: "string[]",
});

const providerSyncEmptyDataType = type({
  dataType: "string",
  pagesFetched: "number",
  sourceRecordsReceived: "number",
  normalizedRecords: "number",
});

const providerSyncError = type({
  dataType: "string",
  code: "string",
  message: "string",
});

const providerSync = type({
  providerCode: "string",
  providerInstanceId: "string",
  requestedFrom: "string",
  requestedTo: "string",
  status: "'processed' | 'partial_failed' | 'failed'",
  batches: providerSyncBatch.array(),
  emptyDataTypes: providerSyncEmptyDataType.array(),
  errors: providerSyncError.array(),
});

const providerSyncJobItem = type({
  dataType: "string",
  from: "string",
  to: "string",
});

const providerSyncJobStatus = type({
  jobId: "string",
  providerCode: "string",
  "providerInstanceId?": "string | null",
  requestedFrom: "string",
  requestedTo: "string",
  "dataTypes?": "string[] | null",
  status: "'queued' | 'running' | 'processed' | 'partial_failed' | 'failed'",
  totalItems: "number",
  completedItems: "number",
  "currentItem?": providerSyncJobItem.or("null"),
  "lastCompletedItem?": providerSyncJobItem.or("null"),
  batchesCount: "number",
  emptyCount: "number",
  errorCount: "number",
  "errorMessage?": "string | null",
  createdAt: "string",
  "startedAt?": "string | null",
  updatedAt: "string",
  "finishedAt?": "string | null",
  "summary?": providerSync.or("null"),
});

const providerSyncJobStart = type({
  jobId: "string",
  status: "'queued' | 'running' | 'processed' | 'partial_failed' | 'failed'",
  createdAt: "string",
});

const providerOAuthStart = type({
  provider: "string",
  authorizationUrl: "string",
  expiresAt: "string",
});

const scheduledSyncRun = type({
  providerCode: "string",
  providerInstanceId: "string",
  status: "'processed' | 'partial_failed' | 'failed'",
  "requestedFrom?": "string | null",
  "requestedTo?": "string | null",
  errors: "string[]",
  summaries: providerSync.array(),
});

/**
 * Resolves to the parsed type only while it still matches the generated API type, so regenerating
 * the API types fails the build here instead of leaving the app unable to parse its own responses.
 */
type StillMatchingApi<Parsed, Declared> = [Parsed, Declared] extends [Declared, Parsed]
  ? Parsed
  : "This schema no longer matches the generated API type";

type ParsedSyncJobStatus = StillMatchingApi<
  typeof providerSyncJobStatus.infer,
  ProviderSyncJobStatusResponse
>;
type ParsedSyncJobStart = StillMatchingApi<
  typeof providerSyncJobStart.infer,
  ProviderSyncJobStartResponse
>;
type ParsedOAuthStart = StillMatchingApi<
  typeof providerOAuthStart.infer,
  ProviderOAuthStartResponse
>;
type ParsedScheduledSyncRun = StillMatchingApi<
  typeof scheduledSyncRun.infer,
  ScheduledSyncRunResponse
>;

const syncJobStatusResult = type({ ok: "true", data: providerSyncJobStatus }).or(apiFailure);
const syncJobStartResult = type({ ok: "true", data: providerSyncJobStart }).or(apiFailure);
const oauthStartResult = type({ ok: "true", data: providerOAuthStart }).or(apiFailure);
const scheduledSyncRunResult = type({ ok: "true", data: scheduledSyncRun }).or(apiFailure);
const acknowledgedResult = type({ ok: "true", data: "unknown" }).or(apiFailure);

export async function readSyncJobStatus(
  response: Response,
): Promise<ApiResult<ParsedSyncJobStatus>> {
  return parsedApiResult(syncJobStatusResult(await response.json()));
}

export async function readSyncJobStart(response: Response): Promise<ApiResult<ParsedSyncJobStart>> {
  return parsedApiResult(syncJobStartResult(await response.json()));
}

export async function readOAuthStart(response: Response): Promise<ApiResult<ParsedOAuthStart>> {
  return parsedApiResult(oauthStartResult(await response.json()));
}

export async function readScheduledSyncRun(
  response: Response,
): Promise<ApiResult<ParsedScheduledSyncRun>> {
  return parsedApiResult(scheduledSyncRunResult(await response.json()));
}

/** For endpoints whose payload the UI never reads: only the success envelope matters. */
export async function readAcknowledgement(response: Response): Promise<ApiResult<unknown>> {
  return parsedApiResult(acknowledgedResult(await response.json()));
}

function parsedApiResult<Payload>(parsed: ApiResult<Payload> | ArkErrors): ApiResult<Payload> {
  return parsed instanceof type.errors
    ? { ok: false, message: `Unexpected response from the health API: ${parsed.summary}` }
    : parsed;
}
