import { NextResponse } from "next/server";
import { syncProvider } from "@/lib/aqtHealthApi";
import type { ProviderSyncRequest } from "@/lib/types";

type RouteContext = {
  params: Promise<{
    providerCode: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { providerCode } = await context.params;
  const body = (await request.json().catch(() => ({}))) as ProviderSyncRequest;
  const result = await syncProvider(providerCode, normalizePayload(body));

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}

function normalizePayload(body: ProviderSyncRequest): ProviderSyncRequest {
  const dataTypes = Array.isArray(body.dataTypes)
    ? body.dataTypes.filter((dataType) => typeof dataType === "string" && dataType.trim())
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
