import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const backendSyncResponse = {
  providerCode: "google-health",
  requestedFrom: null,
  requestedTo: null,
  batches: [],
  errors: [],
};

describe("provider sync proxy route", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("AQT_HEALTH_API_BASE_URL", "http://backend.test");
    vi.stubEnv("AQT_HEALTH_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(backendSyncResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("syncs the provider through the backend and returns its response", async () => {
    const response = await POST(
      new Request("http://frontend.test/api/providers/google-health/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dataTypes: ["steps"], pageSize: 100 }),
      }),
      { params: Promise.resolve({ providerCode: "google-health" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: backendSyncResponse });

    const backendRequest: Request = fetchMock.mock.calls[0][0];
    expect(backendRequest.url).toBe("http://backend.test/api/v2/providers/google-health/sync");
    expect(await backendRequest.json()).toEqual({ dataTypes: ["steps"], pageSize: 100 });
  });

  it("rejects a provider the API does not know without calling the backend", async () => {
    const response = await POST(
      new Request("http://frontend.test/api/providers/fitbit/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ providerCode: "fitbit" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      status: 404,
      message: "Unknown provider code: fitbit.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
