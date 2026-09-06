import { type } from "arktype";

import type { ApiResult, ProviderSyncRequest, ScheduledSyncConfigUpdateRequest } from "./types";

const providerSyncBody = type({
  "from?": "string | null",
  "to?": "string | null",
  "dataTypes?": "string[] | null",
  "pageSize?": "number | null",
});

const scheduledSyncUpdateBody = type({
  "enabled?": "boolean | null",
  "dataTypes?": "string[] | null",
  "cadenceMinutes?": "number | null",
  "lookbackDays?": "number | null",
});

// An absent body means "use the defaults"; anything that is present has to parse,
// because silently substituting {} would run the sync over the wrong range.
async function readJsonBody(request: Request): Promise<ApiResult<unknown>> {
  const raw = await request.text();
  if (raw.trim() === "") return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, message: "Request body is not valid JSON." };
  }
}

export async function readProviderSyncRequest(
  request: Request,
): Promise<ApiResult<ProviderSyncRequest>> {
  const raw = await readJsonBody(request);
  if (!raw.ok) return raw;

  const body = providerSyncBody(raw.data);
  if (body instanceof type.errors) return { ok: false, message: body.summary };

  return {
    ok: true,
    data: {
      from: nonEmpty(body.from),
      to: nonEmpty(body.to),
      dataTypes: presentDataTypes(body.dataTypes),
      pageSize: positiveInteger(body.pageSize),
    },
  };
}

export async function readScheduledSyncConfigUpdate(
  request: Request,
): Promise<ApiResult<ScheduledSyncConfigUpdateRequest>> {
  const raw = await readJsonBody(request);
  if (!raw.ok) return raw;

  const body = scheduledSyncUpdateBody(raw.data);
  if (body instanceof type.errors) return { ok: false, message: body.summary };

  return {
    ok: true,
    data: {
      enabled: body.enabled ?? undefined,
      dataTypes: presentDataTypes(body.dataTypes),
      cadenceMinutes: positiveInteger(body.cadenceMinutes),
      lookbackDays: positiveInteger(body.lookbackDays),
    },
  };
}

function nonEmpty(value?: string | null): string | undefined {
  return value?.trim() || undefined;
}

function presentDataTypes(dataTypes?: string[] | null): string[] | undefined {
  const present = dataTypes?.filter((dataType) => dataType.trim());
  return present && present.length > 0 ? present : undefined;
}

function positiveInteger(value?: number | null): number | undefined {
  return value !== null && value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
