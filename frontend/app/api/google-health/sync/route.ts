import { NextResponse } from "next/server";
import { syncGoogleHealth } from "@/lib/aqtHealthApi";
import type { GoogleHealthSyncRequest } from "@/lib/types";

const supportedDataTypes = new Set(["steps", "sleep", "heart-rate", "weight", "body-fat"]);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as GoogleHealthSyncRequest;
  const payload = normalizePayload(body);
  const result = await syncGoogleHealth(payload);

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}

function normalizePayload(body: GoogleHealthSyncRequest): GoogleHealthSyncRequest {
  const dataTypes = Array.isArray(body.dataTypes)
    ? body.dataTypes.filter((dataType) => supportedDataTypes.has(dataType))
    : undefined;
  const pageSize =
    typeof body.pageSize === "number" && Number.isInteger(body.pageSize) && body.pageSize > 0
      ? body.pageSize
      : undefined;

  return {
    from: nonEmpty(body.from),
    to: nonEmpty(body.to),
    dataTypes: dataTypes && dataTypes.length > 0 ? dataTypes : undefined,
    pageSize,
  };
}

function nonEmpty(value?: string): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
