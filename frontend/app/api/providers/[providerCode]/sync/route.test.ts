import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  syncProvider: vi.fn(),
}));

vi.mock("@/lib/aqtHealthApi", () => ({
  syncProvider: mocks.syncProvider,
}));

describe("provider sync proxy route", () => {
  beforeEach(() => {
    mocks.syncProvider.mockReset();
  });

  it("allows requests to sync data through the backend client", async () => {
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
