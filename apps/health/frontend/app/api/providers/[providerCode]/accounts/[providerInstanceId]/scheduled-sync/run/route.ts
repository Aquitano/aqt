import { NextResponse } from "next/server";
import { runScheduledSyncNow } from "@/lib/aqtHealthApi";

export const maxDuration = 300;

type RouteContext = {
  params: Promise<{
    providerCode: string;
    providerInstanceId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { providerCode, providerInstanceId } = await context.params;
  const result = await runScheduledSyncNow(providerCode, providerInstanceId);

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}
