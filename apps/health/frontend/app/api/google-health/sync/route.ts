import { NextResponse } from "next/server";

import { syncProvider } from "@/lib/aqtHealthApi";
import { readProviderSyncRequest } from "@/lib/syncRequests";

export async function POST(request: Request) {
  const body = await readProviderSyncRequest(request);
  if (!body.ok) return NextResponse.json(body, { status: 400 });

  const result = await syncProvider("google-health", body.data);

  return NextResponse.json(result, {
    status: result.ok ? 200 : (result.status ?? 500),
  });
}
