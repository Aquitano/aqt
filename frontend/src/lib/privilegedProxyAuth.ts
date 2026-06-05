import { NextResponse } from "next/server";

const defaultSessionCookieName = "aqt_health_frontend_session";
const csrfHeaderName = "x-aqt-health-csrf";

type GuardOptions = {
  mutation?: boolean;
};

export function requirePrivilegedProxyAccess(
  request: Request,
  options: GuardOptions = {},
): NextResponse | null {
  const sessionSecret = process.env.AQT_HEALTH_FRONTEND_SESSION_SECRET;
  if (!sessionSecret) {
    return unauthorized("Frontend session authentication is not configured.");
  }

  const cookieName = process.env.AQT_HEALTH_FRONTEND_SESSION_COOKIE ?? defaultSessionCookieName;
  const sessionCookie = cookieValue(request.headers.get("cookie"), cookieName);
  if (!sessionCookie || sessionCookie !== sessionSecret) {
    return unauthorized("Authentication is required.");
  }

  if (options.mutation) {
    if (request.headers.get(csrfHeaderName) !== "1") {
      return forbidden("CSRF protection failed.");
    }

    if (!isSameOrigin(request)) {
      return forbidden("Cross-origin mutation requests are not allowed.");
    }
  }

  return null;
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ ok: false, message }, { status: 401 });
}

function forbidden(message: string): NextResponse {
  return NextResponse.json({ ok: false, message }, { status: 403 });
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return safeDecodeURIComponent(rawValue.join("="));
  }

  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;

  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return origin === `${proto}://${host}`;
}
