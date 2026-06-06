import { NextResponse } from "next/server";
import { startProviderOAuth } from "@/lib/aqtHealthApi";

type RouteContext = {
  params: Promise<{
    providerCode: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { providerCode } = await context.params;
  const result = await startProviderOAuth(providerCode);

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}
