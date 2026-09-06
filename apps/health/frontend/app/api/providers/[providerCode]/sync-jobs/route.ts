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
  const body = await readProviderSyncRequest(request);
  if (!body.ok) return NextResponse.json(body, { status: 400 });

  const result = await startProviderSyncJob(providerCode, body.data);

  return NextResponse.json(result, {
    status: result.ok ? 202 : (result.status ?? 500),
  });
}
