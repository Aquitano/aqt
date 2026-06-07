import { NextResponse } from "next/server";
import { getProviderSyncJob } from "@/lib/aqtHealthApi";

type RouteContext = {
  params: Promise<{
    providerCode: string;
    jobId: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { providerCode, jobId } = await context.params;
  const result = await getProviderSyncJob(providerCode, jobId);

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}
