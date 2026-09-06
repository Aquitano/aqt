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
  const body = await readProviderSyncRequest(request);
  if (!body.ok) return NextResponse.json(body, { status: 400 });

  const result = await syncProvider(providerCode, body.data);

  return NextResponse.json(result, {
    status: result.ok ? 200 : (result.status ?? 500),
  });
}
