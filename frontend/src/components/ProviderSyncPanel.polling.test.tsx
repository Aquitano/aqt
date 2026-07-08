import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  ApiResult,
  ProviderCatalogResponse,
  ProviderDescriptor,
  ProviderStatus,
  ProviderStatusCatalogResponse,
  ProviderSyncJobStatusResponse,
} from "@/lib/types";
import { ProviderSyncPanel } from "./ProviderSyncPanel";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const SYNC_JOB_STORAGE_KEY = "aqt-health.provider-sync.active-job";

function descriptor(): ProviderDescriptor {
  return {
    providerCode: "google-health",
    displayName: "Google Health",
    authType: "oauth2",
    requiresAuthentication: true,
    supportedDataTypes: ["steps"],
    defaultDataTypes: ["steps"],
    maxSyncRangeDays: 90,
    supportsPageSize: false,
    workflowEndpoints: {
      oauthStart: "/api/v2/providers/google-health/oauth/start",
      oauthCallback: "/api/v2/providers/google-health/oauth/callback",
      accounts: "/api/v2/providers/google-health/accounts",
      disconnect: "/api/v2/providers/google-health/accounts/{id}/disconnect",
      reconnect: "/api/v2/providers/google-health/accounts/{id}/reconnect",
      sync: "/api/v2/providers/google-health/sync",
    },
  };
}

function status(): ProviderStatus {
  return {
    providerCode: "google-health",
    displayName: "Google Health",
    configured: true,
    connected: true,
    needsAuthentication: false,
    canSync: true,
    nextAction: "sync",
    accounts: [],
  };
}

function catalog(): ApiResult<ProviderCatalogResponse> {
  return { ok: true, data: { providers: [descriptor()] } };
}

function statuses(): ApiResult<ProviderStatusCatalogResponse> {
  return { ok: true, data: { providers: [status()] } };
}

function jobStatus(
  overrides: Partial<ProviderSyncJobStatusResponse> = {},
): ProviderSyncJobStatusResponse {
  return {
    jobId: "job-1",
    providerCode: "google-health",
    requestedFrom: "2026-04-01T00:00:00.000Z",
    requestedTo: "2026-04-02T00:00:00.000Z",
    status: "running",
    totalItems: 2,
    completedItems: 1,
    batchesCount: 0,
    emptyCount: 0,
    errorCount: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    startedAt: "2026-04-01T00:00:01.000Z",
    updatedAt: "2026-04-01T00:00:10.000Z",
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <ProviderSyncPanel
      catalog={catalog()}
      statuses={statuses()}
      scheduledSyncConfigs={[]}
    />,
  );
}

function storeActiveJob() {
  window.localStorage.setItem(
    SYNC_JOB_STORAGE_KEY,
    JSON.stringify({ providerCode: "google-health", jobId: "job-1" }),
  );
}

describe("ProviderSyncPanel polling", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    mocks.refresh.mockReset();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("rehydrates the active job from localStorage and polls its status", async () => {
    storeActiveJob();
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, data: jobStatus() }),
    });

    renderPanel();

    expect(screen.getByRole("button", { name: /syncing/i })).toBeDisabled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/providers/google-health/sync-jobs/job-1",
      );
    });
    await screen.findByText(/1 of 2 windows complete/);
  });

  it("stops polling and clears the stored job when the status check throws", async () => {
    storeActiveJob();
    fetchMock.mockRejectedValue(new Error("network down"));

    renderPanel();

    await screen.findByText(/network down/);
    expect(window.localStorage.getItem(SYNC_JOB_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "Start sync" })).toBeEnabled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the router and clears the stored job when the sync finishes", async () => {
    storeActiveJob();
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: jobStatus({
          status: "processed",
          completedItems: 2,
          finishedAt: "2026-04-01T00:01:00.000Z",
          summary: {
            providerCode: "google-health",
            providerInstanceId: "google-health-me",
            requestedFrom: "2026-04-01T00:00:00.000Z",
            requestedTo: "2026-04-02T00:00:00.000Z",
            status: "processed",
            batches: [],
            emptyDataTypes: [],
            errors: [],
          },
        }),
      }),
    });

    renderPanel();

    await screen.findByText(/Synced 0 batches, created 0 metrics/);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(SYNC_JOB_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "Start sync" })).toBeEnabled();
  });
});
