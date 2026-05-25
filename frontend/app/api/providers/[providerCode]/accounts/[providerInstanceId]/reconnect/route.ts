import { NextResponse } from "next/server";
import { reconnectProviderAccount } from "@/lib/aqtHealthApi";

type RouteContext = {
  params: Promise<{
    providerCode: string;
    providerInstanceId: string;
  }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { providerCode, providerInstanceId } = await context.params;
  const result = await reconnectProviderAccount(providerCode, providerInstanceId);

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}
