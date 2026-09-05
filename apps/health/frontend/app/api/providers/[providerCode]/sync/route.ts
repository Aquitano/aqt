import { NextResponse } from "next/server";

import { syncProvider } from "@/lib/aqtHealthApi";
import { readProviderSyncRequest } from "@/lib/syncRequests";

export const maxDuration = 300;

type RouteContext = {
  params: Promise<{
    providerCode: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { providerCode } = await context.params;
  const result = await syncProvider(providerCode, await readProviderSyncRequest(request));

  return NextResponse.json(result, {
    status: result.ok ? 200 : (result.status ?? 500),
  });
}
