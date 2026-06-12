import { describe, it, expect } from "vitest";
import type {
  ProviderDescriptor,
  ProviderStatus,
  ProviderAccountStatus,
} from "@/lib/types";
import {
  actionLabel,
  actionDetail,
  buildProviderSyncItems,
  primaryOAuthLabel,
  formatStatus,
} from "./ProviderSyncPanel";

function descriptor(
  overrides: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
  return {
    providerCode: "google-health",
    displayName: "Google Health",
    authType: "oauth2",
    requiresAuthentication: true,
    supportedDataTypes: ["steps", "heart_rate"],
    defaultDataTypes: ["steps"],
    maxSyncRangeDays: 90,
    supportsPageSize: true,
    workflowEndpoints: {
      oauthStart: "/api/v2/providers/google-health/oauth/start",
      oauthCallback: "/api/v2/providers/google-health/oauth/callback",
      accounts: "/api/v2/providers/google-health/accounts",
      disconnect: "/api/v2/providers/google-health/accounts/{id}/disconnect",
      reconnect: "/api/v2/providers/google-health/accounts/{id}/reconnect",
      sync: "/api/v2/providers/google-health/sync",
    },
    ...overrides,
  };
}

function status(
  overrides: Partial<ProviderStatus> = {},
): ProviderStatus {
  return {
    providerCode: "google-health",
    displayName: "Google Health",
    configured: true,
    connected: true,
    needsAuthentication: false,
    canSync: true,
    nextAction: "sync",
    accounts: [],
    ...overrides,
  };
}

function account(
  overrides: Partial<ProviderAccountStatus> = {},
): ProviderAccountStatus {
  return {
    providerInstanceId: "google-health-me",
    status: "connected",
    tokenStatus: "valid",
    ...overrides,
  };
}

describe("actionLabel", () => {
  it("returns configure label when nextAction is configure", () => {
    const result = actionLabel(
      descriptor(),
      status({ nextAction: "configure" }),
    );
    expect(result).toBe("Google Health is not configured");
  });

  it("returns connect label when nextAction is connect", () => {
    const result = actionLabel(
      descriptor(),
      status({ nextAction: "connect" }),
    );
    expect(result).toBe("Google Health needs OAuth");
  });

  it("returns reconnect label when nextAction is reconnect", () => {
    const result = actionLabel(
      descriptor(),
      status({ nextAction: "reconnect" }),
    );
    expect(result).toBe("Google Health needs reconnection");
  });

  it("returns sync label when nextAction is sync", () => {
    const result = actionLabel(
      descriptor(),
      status({ nextAction: "sync" }),
    );
    expect(result).toBe("Google Health is ready to sync");
  });
});

describe("actionDetail", () => {
  it("returns credential setup detail for configure", () => {
    const result = actionDetail(
      descriptor(),
      status({ nextAction: "configure" }),
    );
    expect(result).toContain("credentials");
  });

  it("returns OAuth login detail for connect with oauthStart endpoint", () => {
    const result = actionDetail(
      descriptor(),
      status({ nextAction: "connect" }),
    );
    expect(result).toBe("Login before syncing this provider.");
  });

  it("returns reconnect detail for reconnect with oauthStart endpoint", () => {
    const result = actionDetail(
      descriptor(),
      status({ nextAction: "reconnect" }),
    );
    expect(result).toBe("Restart OAuth if provider access was revoked.");
  });

  it("returns single account detail for sync with one account", () => {
    const result = actionDetail(
      descriptor(),
      status({ nextAction: "sync", accounts: [account()] }),
    );
    expect(result).toBe("Connected as google-health-me.");
  });

  it("returns multi-account detail for sync with multiple accounts", () => {
    const result = actionDetail(
      descriptor(),
      status({
        nextAction: "sync",
        accounts: [
          account({ providerInstanceId: "acc-1" }),
          account({ providerInstanceId: "acc-2" }),
        ],
      }),
    );
    expect(result).toBe("2 connected accounts.");
  });

  it("returns generic connect detail when oauthStart is absent", () => {
    const noOAuth = descriptor({
      workflowEndpoints: {
        oauthStart: null,
        oauthCallback: null,
        accounts: null,
        disconnect: null,
        reconnect: null,
        sync: "/sync",
      },
    });
    const result = actionDetail(noOAuth, status({ nextAction: "connect" }));
    expect(result).toBe("Connect this provider before syncing.");
  });
});

describe("primaryOAuthLabel", () => {
  it("returns Connect for connect action", () => {
    expect(primaryOAuthLabel(status({ nextAction: "connect" }))).toBe(
      "Connect",
    );
  });

  it("returns Reconnect for reconnect action", () => {
    expect(primaryOAuthLabel(status({ nextAction: "reconnect" }))).toBe(
      "Reconnect",
    );
  });

  it("returns Start OAuth for sync action", () => {
    expect(primaryOAuthLabel(status({ nextAction: "sync" }))).toBe(
      "Start OAuth",
    );
  });

  it("returns Start OAuth for configure action", () => {
    expect(primaryOAuthLabel(status({ nextAction: "configure" }))).toBe(
      "Start OAuth",
    );
  });
});

describe("formatStatus", () => {
  it("capitalizes single word", () => {
    expect(formatStatus("connected")).toBe("Connected");
  });

  it("splits and capitalizes snake_case", () => {
    expect(formatStatus("needs_reauth")).toBe("Needs Reauth");
  });

  it("handles multi-segment snake_case", () => {
    expect(formatStatus("configuration_error")).toBe("Configuration Error");
  });

  it("handles not_connected", () => {
    expect(formatStatus("not_connected")).toBe("Not Connected");
  });

  it("handles disconnected", () => {
    expect(formatStatus("disconnected")).toBe("Disconnected");
  });
});

describe("buildProviderSyncItems", () => {
  it("splits Google heart-rate into provider-safe progress windows", () => {
    const items = buildProviderSyncItems(descriptor({
      supportedDataTypes: ["heart-rate"],
      defaultDataTypes: ["heart-rate"],
    }), {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-06-15T00:00:00.000Z",
      dataTypes: ["heart-rate"],
    });

    expect(items.map((item) => item.payload)).toEqual([
      {
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-05-02T00:00:00.000Z",
        dataTypes: ["heart-rate"],
      },
      {
        from: "2026-05-02T00:00:00.000Z",
        to: "2026-06-02T00:00:00.000Z",
        dataTypes: ["heart-rate"],
      },
      {
        from: "2026-06-02T00:00:00.000Z",
        to: "2026-06-15T00:00:00.000Z",
        dataTypes: ["heart-rate"],
      },
    ]);
  });

  it("splits other provider data into 31-day windows per data type", () => {
    const items = buildProviderSyncItems(descriptor({
      supportedDataTypes: ["steps", "sleep"],
      defaultDataTypes: ["steps", "sleep"],
    }), {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-07-01T00:00:00.000Z",
      dataTypes: ["steps", "sleep"],
      pageSize: 5000,
    });

    expect(items).toHaveLength(6);
    expect(items[0].payload).toEqual({
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-05-02T00:00:00.000Z",
      dataTypes: ["steps"],
      pageSize: 5000,
    });
    expect(items[3].payload).toEqual({
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-05-02T00:00:00.000Z",
      dataTypes: ["sleep"],
      pageSize: 5000,
    });
  });

  it("keeps default sync as one backend request when dates are omitted", () => {
    const items = buildProviderSyncItems(descriptor(), {
      dataTypes: ["steps"],
    });

    expect(items).toEqual([{
      label: "Default sync window",
      payload: {
        dataTypes: ["steps"],
      },
    }]);
  });
});
