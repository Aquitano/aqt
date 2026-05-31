import { NextResponse } from "next/server";
import {
  getScheduledSyncConfig,
  updateScheduledSyncConfig,
} from "@/lib/aqtHealthApi";
import type { ScheduledSyncConfigUpdateRequest } from "@/lib/types";

type RouteContext = {
  params: Promise<{
    providerCode: string;
    providerInstanceId: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { providerCode, providerInstanceId } = await context.params;
  const result = await getScheduledSyncConfig(providerCode, providerInstanceId);

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}

export async function PUT(request: Request, context: RouteContext) {
  const { providerCode, providerInstanceId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as ScheduledSyncConfigUpdateRequest;
  const result = await updateScheduledSyncConfig(providerCode, providerInstanceId, normalizePayload(body));

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}

function normalizePayload(body: ScheduledSyncConfigUpdateRequest): ScheduledSyncConfigUpdateRequest {
  const dataTypes = Array.isArray(body.dataTypes)
    ? body.dataTypes.filter((dataType) => typeof dataType === "string" && dataType.trim())
    : undefined;
  return {
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    dataTypes: dataTypes && dataTypes.length > 0 ? dataTypes : undefined,
    cadenceMinutes: positiveInteger(body.cadenceMinutes),
    lookbackDays: positiveInteger(body.lookbackDays),
  };
}

function positiveInteger(value?: number): number | undefined {
  return Number.isInteger(value) && value && value > 0 ? value : undefined;
}
