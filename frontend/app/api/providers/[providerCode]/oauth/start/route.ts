import { NextResponse } from "next/server";
import { startProviderOAuth } from "@/lib/aqtHealthApi";
import { requirePrivilegedProxyAccess } from "@/lib/privilegedProxyAuth";

type RouteContext = {
  params: Promise<{
    providerCode: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const guard = requirePrivilegedProxyAccess(request, { mutation: true });
  if (guard) return guard;

  const { providerCode } = await context.params;
  const result = await startProviderOAuth(providerCode);

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.status ?? 500,
  });
}
