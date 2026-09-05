import { NextResponse } from "next/server";

import { startProviderSyncJob } from "@/lib/aqtHealthApi";
import { readProviderSyncRequest } from "@/lib/syncRequests";

type RouteContext = {
  params: Promise<{
    providerCode: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { providerCode } = await context.params;
  const result = await startProviderSyncJob(providerCode, await readProviderSyncRequest(request));

  return NextResponse.json(result, {
    status: result.ok ? 202 : (result.status ?? 500),
  });
}
