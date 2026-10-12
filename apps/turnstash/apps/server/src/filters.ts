import type { StatsFilter } from "@aqt/turnstash-api";
import type { ProviderId } from "@aqt/turnstash-core";
import { type AnyColumn, and, eq, exists, gte, lt, type SQL, sql } from "drizzle-orm";

import { conversationMachines, conversations, modelRequests, valuations } from "./db/schema.ts";

// Stats group conversations without a project path under this key, so filtering by it selects them.
export const unknownProject = "unknown";

export const projectCondition = (projectKey: string): SQL =>
  projectKey === unknownProject
    ? sql`(${conversations.projectKey} is null or ${conversations.projectKey} = ${unknownProject})`
    : eq(conversations.projectKey, projectKey);

export const activeValuation = and(
  eq(valuations.requestId, modelRequests.id),
  eq(valuations.active, true),
);

export const activeCost = sql<string>`coalesce(sum(case when ${valuations.active} then ${valuations.costUsd} else 0 end), 0)`;

export interface DateWindow {
  readonly from: Date | null;
  readonly to: Date | null;
}

const isDateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export const dateWindow = (filter: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): DateWindow => {
  const from =
    filter.from === undefined
      ? null
      : new Date(isDateOnly(filter.from) ? `${filter.from}T00:00:00Z` : filter.from);
  const to =
    filter.to === undefined
      ? null
      : isDateOnly(filter.to)
        ? new Date(new Date(`${filter.to}T00:00:00Z`).getTime() + 86_400_000)
        : new Date(filter.to);
  return { from, to };
};

const filterConditions = (
  filter: StatsFilter,
  columns: {
    readonly from: AnyColumn<{ data: Date }>;
    readonly to: AnyColumn<{ data: Date }>;
    readonly provider: AnyColumn<{ data: ProviderId }>;
    readonly conversationId: AnyColumn<{ data: string }>;
  },
): SQL | undefined => {
  const window = dateWindow(filter);
  const conditions: Array<SQL> = [];
  if (window.from) conditions.push(gte(columns.from, window.from));
  if (window.to) conditions.push(lt(columns.to, window.to));
  if (filter.provider !== undefined) conditions.push(eq(columns.provider, filter.provider));
  if (filter.projectKey !== undefined) conditions.push(projectCondition(filter.projectKey));
  if (filter.machineId !== undefined) {
    conditions.push(
      exists(
        sql`(select 1 from ${conversationMachines} where ${conversationMachines.conversationId} = ${columns.conversationId} and ${conversationMachines.machineId} = ${filter.machineId}::uuid)`,
      ),
    );
  }
  return and(...conditions);
};

export const requestConditions = (filter: StatsFilter): SQL | undefined =>
  filterConditions(filter, {
    from: modelRequests.requestedAt,
    to: modelRequests.requestedAt,
    provider: modelRequests.provider,
    conversationId: modelRequests.conversationId,
  });

export const conversationConditions = (filter: StatsFilter): SQL | undefined =>
  filterConditions(filter, {
    from: conversations.endedAt,
    to: conversations.startedAt,
    provider: conversations.provider,
    conversationId: conversations.id,
  });

export const number = (value: string | number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
