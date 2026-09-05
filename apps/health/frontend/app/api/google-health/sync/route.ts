import { NextResponse } from "next/server";

import { syncProvider } from "@/lib/aqtHealthApi";
import { readProviderSyncRequest } from "@/lib/syncRequests";

export async function POST(request: Request) {
  const result = await syncProvider("google-health", await readProviderSyncRequest(request));

  return NextResponse.json(result, {
    status: result.ok ? 200 : (result.status ?? 500),
  });
}
