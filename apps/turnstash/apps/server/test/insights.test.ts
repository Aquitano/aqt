import { expect, setDefaultTimeout, test } from "bun:test";

import { PlanEndsBeforeStart, PlanOverlap } from "@aqt/turnstash-api";
import { MachineId, type ProviderId, sha256Hex } from "@aqt/turnstash-core";
import { Effect } from "effect";

import { changePlan, createPlan, listPlans, updatePlan } from "../src/admin.ts";
import { Db } from "../src/db/client.ts";
import {
  conversationMachines,
  conversations,
  machines,
  modelRequests,
  subscriptionPlans,
  valuations,
} from "../src/db/schema.ts";
import { applyCommitBatch, commitsForConversation, commitsForProject } from "../src/git.ts";
import { computeStats, subscriptionValues } from "../src/stats.ts";
import { ensureBundledCatalog } from "../src/valuation.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(30_000);

const machineId = MachineId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const projectPath = "/home/dev/project";
const at = (minute: number) => new Date(Date.UTC(2026, 8, 21, 9, minute));

const insertMachine = Effect.gen(function* () {
  const db = yield* Db;
  yield* db
    .insert(machines)
    .values({ id: machineId, name: "a", os: "darwin", arch: "arm64", tokenHash: sha256Hex("a") });
});

// Priced requests written directly, so each test controls exact times and costs.
const seedConversation = Effect.fn("test.seedConversation")(function* (
  provider: ProviderId,
  conversationKey: string,
  requests: ReadonlyArray<{ readonly minute: number; readonly costUsd: number }>,
) {
  const db = yield* Db;
  const catalog = yield* ensureBundledCatalog();
  const minutes = requests.map((request) => request.minute);
  const [conversation] = yield* db
    .insert(conversations)
    .values({
      provider,
      conversationKey,
      projectPath,
      projectKey: "project",
      startedAt: at(Math.min(...minutes)),
      endedAt: at(Math.max(...minutes)),
      requestCount: requests.length,
      parserVersion: 1,
    })
    .returning({ id: conversations.id });
  if (conversation === undefined) return yield* Effect.die("conversation insert returned no row");
  yield* db.insert(conversationMachines).values({ conversationId: conversation.id, machineId });
  const rows = yield* db
    .insert(modelRequests)
    .values(
      requests.map((request, index) => ({
        conversationId: conversation.id,
        provider,
        requestKey: `${conversationKey}-${index}`,
        modelRaw: "claude-opus-5",
        modelId: "claude-opus-5",
        requestedAt: at(request.minute),
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        usageBasis: "reported" as const,
      })),
    )
    .returning({ id: modelRequests.id });
  yield* db.insert(valuations).values(
    rows.map((row, index) => ({
      requestId: row.id,
      catalogVersion: catalog ?? "",
      costUsd: (requests[index]?.costUsd ?? 0).toFixed(10),
      active: true,
    })),
  );
  return conversation.id;
});

test("each commit is charged for its conversation's spend since the previous commit", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const conversationId = yield* seedConversation("claude", "session", [
        { minute: 0, costUsd: 1 },
        { minute: 10, costUsd: 2 },
        { minute: 20, costUsd: 4 },
        { minute: 30, costUsd: 8 },
      ]);
      const repo = "github.com/acme/project";
      const commit = (n: number, minute: number) => ({
        repo,
        sha: n.toString(16).padStart(40, "0"),
        parents: [],
        authoredAt: at(minute).toISOString(),
        committedAt: at(minute).toISOString(),
        subject: `commit ${n}`,
        ref: "main",
        onDefaultBranch: true,
      });
      yield* applyCommitBatch(machineId, {
        machineId,
        repositories: [{ path: projectPath, repo, remote: repo }],
        commits: [commit(1, 10), commit(2, 20)],
      });

      const linked = yield* commitsForConversation(conversationId);
      expect(linked.map((row) => [row.subject, row.costUsd])).toEqual([
        ["commit 2", 4],
        ["commit 1", 3],
      ]);
      expect((yield* commitsForProject("project")).map((row) => row.costUsd)).toEqual([4, 3]);
    }),
  );
});

test("subscription value sets each provider's prorated plans beside its API-equivalent spend", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const db = yield* Db;
      yield* seedConversation("claude", "claude-session", [
        { minute: 0, costUsd: 4 },
        { minute: 5, costUsd: 6 },
      ]);
      yield* seedConversation("codex", "codex-session", [{ minute: 0, costUsd: 2 }]);
      const plan = (
        provider: ProviderId,
        name: string,
        monthlyPrice: string,
        endedOn?: string,
      ) => ({
        provider,
        name,
        monthlyPrice,
        startedOn: "2026-01-01",
        endedOn: endedOn ?? null,
      });
      yield* db
        .insert(subscriptionPlans)
        .values([
          plan("claude", "Claude Max 5x", "100"),
          plan("codex", "ChatGPT Plus", "20"),
          plan("copilot", "GitHub Copilot Pro", "10"),
          plan("cursor", "Cursor Pro", "20", "2026-08-15"),
        ]);

      const stats = yield* computeStats({ from: "2026-09-01", to: "2026-09-30" });
      expect(
        stats.subscriptions.map((row) => ({
          ...row,
          planCosts: row.planCosts.map((cost) => ({
            ...cost,
            amount: Number(cost.amount.toFixed(6)),
          })),
          apiUsd: Number(row.apiUsd.toFixed(6)),
        })),
      ).toEqual([
        {
          provider: "claude",
          plans: ["Claude Max 5x"],
          planCosts: [{ currency: "USD", amount: 100 }],
          apiUsd: 10,
        },
        {
          provider: "codex",
          plans: ["ChatGPT Plus"],
          planCosts: [{ currency: "USD", amount: 20 }],
          apiUsd: 2,
        },
        {
          provider: "copilot",
          plans: ["GitHub Copilot Pro"],
          planCosts: [{ currency: "USD", amount: 10 }],
          apiUsd: 0,
        },
      ]);
    }),
  );
});

test("a plan period may not overlap another period of the same provider", async () => {
  await runTest(
    Effect.gen(function* () {
      const pro = yield* createPlan({
        provider: "claude",
        name: "Claude Pro",
        monthlyPrice: 20,
        currency: "EUR",
        startedOn: "2026-01-01",
      });
      yield* createPlan({
        provider: "codex",
        name: "ChatGPT Plus",
        monthlyPrice: 20,
        startedOn: "2026-01-01",
      });
      const earlier = yield* createPlan({
        provider: "claude",
        name: "Claude Max 5x",
        monthlyPrice: 100,
        startedOn: "2025-10-01",
        endedOn: "2025-12-31",
      });

      expect(yield* updatePlan(earlier.id, { endedOn: "2026-01-01" }).pipe(Effect.flip)).toEqual(
        new PlanOverlap({ existing: pro }),
      );
      expect(
        yield* createPlan({
          provider: "claude",
          name: "Claude Max 20x",
          monthlyPrice: 200,
          startedOn: "2026-06-01",
          endedOn: "2026-06-30",
        }).pipe(Effect.flip),
      ).toEqual(new PlanOverlap({ existing: pro }));
      expect(yield* listPlans()).toEqual([
        pro,
        expect.objectContaining({ provider: "codex" }),
        earlier,
      ]);
    }),
  );
});

test("changing a plan ends the current period the day before and opens the next, or changes nothing", async () => {
  await runTest(
    Effect.gen(function* () {
      const pro = yield* createPlan({
        provider: "claude",
        name: "Claude Pro",
        monthlyPrice: 20,
        currency: "EUR",
        startedOn: "2026-01-01",
      });
      const max = yield* changePlan(pro.id, {
        name: "Claude Max 5x",
        monthlyPrice: 100,
        effectiveOn: "2026-03-01",
      });
      expect(max).toMatchObject({ currency: "EUR", startedOn: "2026-03-01", endedOn: null });
      expect(yield* listPlans()).toEqual([max, { ...pro, endedOn: "2026-02-28" }]);

      const ended = yield* updatePlan(max.id, { endedOn: "2026-04-30" });
      const before = yield* listPlans();
      expect(
        yield* changePlan(ended.id, {
          name: "Claude Pro",
          monthlyPrice: 20,
          effectiveOn: "2026-06-01",
        }).pipe(Effect.flip),
      ).toEqual(new PlanEndsBeforeStart({ startedOn: "2026-06-01", endedOn: "2026-04-30" }));
      expect(yield* listPlans()).toEqual(before);
    }),
  );
});

test("subscription value prorates each side of a plan change in the plan's own currency", async () => {
  await runTest(
    Effect.gen(function* () {
      const pro = yield* createPlan({
        provider: "claude",
        name: "Claude Pro",
        monthlyPrice: 20,
        currency: "EUR",
        startedOn: "2026-01-01",
      });
      yield* changePlan(pro.id, {
        name: "Claude Max 5x",
        monthlyPrice: 100,
        effectiveOn: "2026-09-16",
      });
      yield* createPlan({
        provider: "cursor",
        name: "Cursor Pro",
        monthlyPrice: 20,
        startedOn: "2026-09-01",
      });

      expect(
        yield* subscriptionValues(
          { from: "2026-09-01", to: "2026-09-30" },
          null,
          new Map([["claude", 50]]),
        ),
      ).toEqual([
        {
          provider: "claude",
          plans: ["Claude Pro", "Claude Max 5x"],
          planCosts: [{ currency: "EUR", amount: 60 }],
          apiUsd: 50,
        },
        {
          provider: "cursor",
          plans: ["Cursor Pro"],
          planCosts: [{ currency: "USD", amount: 20 }],
          apiUsd: 0,
        },
      ]);
    }),
  );
});
