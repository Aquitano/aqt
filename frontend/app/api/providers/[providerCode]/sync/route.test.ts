import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  syncProvider: vi.fn(),
}));

vi.mock("@/lib/aqtHealthApi", () => ({
  syncProvider: mocks.syncProvider,
}));

const sessionSecret = "test-session-secret";

describe("provider sync proxy route", () => {
  beforeEach(() => {
    process.env.AQT_HEALTH_FRONTEND_SESSION_SECRET = sessionSecret;
    delete process.env.AQT_HEALTH_FRONTEND_SESSION_COOKIE;
    mocks.syncProvider.mockReset();
  });

  afterEach(() => {
    delete process.env.AQT_HEALTH_FRONTEND_SESSION_SECRET;
    delete process.env.AQT_HEALTH_FRONTEND_SESSION_COOKIE;
  });

  it("returns 401 before using the backend client when the session is missing", async () => {
    const response = await POST(
      new Request("http://frontend.test/api/providers/google-health/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://frontend.test",
          Host: "frontend.test",
          "X-AQT-Health-CSRF": "1",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ providerCode: "google-health" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.syncProvider).not.toHaveBeenCalled();
  });

  it("allows an authenticated same-origin request with the CSRF header", async () => {
    mocks.syncProvider.mockResolvedValue({
      ok: true,
      data: {
        providerCode: "google-health",
        requestedFrom: null,
        requestedTo: null,
        batches: [],
        errors: [],
      },
    });

    const response = await POST(
      new Request("http://frontend.test/api/providers/google-health/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `aqt_health_frontend_session=${encodeURIComponent(sessionSecret)}`,
          Origin: "http://frontend.test",
          Host: "frontend.test",
          "X-AQT-Health-CSRF": "1",
        },
        body: JSON.stringify({ dataTypes: ["steps"], pageSize: 100 }),
      }),
      { params: Promise.resolve({ providerCode: "google-health" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        providerCode: "google-health",
        requestedFrom: null,
        requestedTo: null,
        batches: [],
        errors: [],
      },
    });
    expect(mocks.syncProvider).toHaveBeenCalledWith("google-health", {
      from: undefined,
      to: undefined,
      dataTypes: ["steps"],
      pageSize: 100,
    });
  });
});
