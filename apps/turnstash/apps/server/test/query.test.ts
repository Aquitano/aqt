import { expect, test } from "bun:test";

import { Effect } from "effect";

import { Db } from "../src/db/client.ts";
import { apiTokens, conversations, modelRequests } from "../src/db/schema.ts";
import { ensureReaderRole, runQuery } from "../src/query.ts";
import { runTest } from "./support.ts";

const failureMessage = (sql: string) =>
  runQuery({ sql }).pipe(
    Effect.as("succeeded"),
    Effect.catchTag("BadRequest", (error) => Effect.succeed(error.message)),
  );

test("queries read the analytics views, capped at the limit", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* ensureReaderRole();
      const db = yield* Db;
      const id = crypto.randomUUID();
      const at = new Date("2026-11-01T10:00:00Z");
      yield* db.insert(conversations).values({
        id,
        provider: "claude",
        conversationKey: "query-session",
        projectKey: "aqt",
        startedAt: at,
        endedAt: new Date("2026-11-01T10:30:00Z"),
        parserVersion: 1,
      });
      yield* db.insert(modelRequests).values(
        ["a", "b", "c"].map((key, index) => ({
          conversationId: id,
          provider: "claude" as const,
          requestKey: key,
          modelRaw: "claude-opus-5-5",
          modelId: "claude-opus-5-5",
          requestedAt: at,
          inputTokens: 10 * (index + 1),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          outputTokens: 5,
          reasoningTokens: 0,
          usageBasis: "reported" as const,
        })),
      );

      const result = yield* runQuery({
        sql: `select s.project_key, s.duration_seconds, r.input_tokens, r.cost_usd
              from requests r join sessions s on s.id = r.session_id
              order by r.input_tokens -- cheapest first`,
        limit: 2,
      });
      expect(result).toEqual({
        rows: [
          { project_key: "aqt", duration_seconds: 1800, input_tokens: 10, cost_usd: null },
          { project_key: "aqt", duration_seconds: 1800, input_tokens: 20, cost_usd: null },
        ],
        truncated: true,
      });
    }),
  );
});

test("queries cannot reach the tables behind the views or change anything", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* ensureReaderRole();
      const db = yield* Db;
      yield* db.insert(apiTokens).values({ name: "secret", tokenHash: "hash", scopes: ["read"] });

      expect(yield* failureMessage("select * from public.api_tokens;")).toContain(
        "permission denied",
      );
      expect(
        yield* failureMessage(
          "select set_config('role', 'turnstash', true), query_to_xml('select * from public.api_tokens', true, false, '')",
        ),
      ).toContain("permission denied");
      expect(
        yield* failureMessage("select 1) as q; delete from public.api_tokens; select (1"),
      ).toContain("multiple commands");
      expect(yield* db.select().from(apiTokens)).toHaveLength(1);
    }),
  );
});
