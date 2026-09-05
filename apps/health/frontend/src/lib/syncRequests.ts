import { type } from "arktype";

import type { ProviderSyncRequest, ScheduledSyncConfigUpdateRequest } from "./types";

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

export async function readProviderSyncRequest(request: Request): Promise<ProviderSyncRequest> {
  const body = providerSyncBody(await request.json().catch(() => ({})));
  if (body instanceof type.errors) return {};

  return {
    from: nonEmpty(body.from),
    to: nonEmpty(body.to),
    dataTypes: presentDataTypes(body.dataTypes),
    pageSize: positiveInteger(body.pageSize),
  };
}

export async function readScheduledSyncConfigUpdate(
  request: Request,
): Promise<ScheduledSyncConfigUpdateRequest> {
  const body = scheduledSyncUpdateBody(await request.json().catch(() => ({})));
  if (body instanceof type.errors) return {};

  return {
    enabled: body.enabled ?? undefined,
    dataTypes: presentDataTypes(body.dataTypes),
    cadenceMinutes: positiveInteger(body.cadenceMinutes),
    lookbackDays: positiveInteger(body.lookbackDays),
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
