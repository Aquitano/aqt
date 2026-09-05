import { NextResponse } from "next/server";

import { getScheduledSyncConfig, updateScheduledSyncConfig } from "@/lib/aqtHealthApi";
import { readScheduledSyncConfigUpdate } from "@/lib/syncRequests";

type RouteContext = {
  params: Promise<{
    providerCode: string;
    providerInstanceId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { providerCode, providerInstanceId } = await context.params;
  const result = await getScheduledSyncConfig(providerCode, providerInstanceId);

  return NextResponse.json(result, {
    status: result.ok ? 200 : (result.status ?? 500),
  });
}

export async function PUT(request: Request, context: RouteContext) {
  const { providerCode, providerInstanceId } = await context.params;
  const result = await updateScheduledSyncConfig(
    providerCode,
    providerInstanceId,
    await readScheduledSyncConfigUpdate(request),
  );

  return NextResponse.json(result, {
    status: result.ok ? 200 : (result.status ?? 500),
  });
}
