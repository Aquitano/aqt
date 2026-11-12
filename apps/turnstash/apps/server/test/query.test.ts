import { expect, test } from "bun:test";

import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { readerRole } from "../src/db/analytics.ts";
import { Db } from "../src/db/client.ts";
import { apiTokens, conversations, modelRequests } from "../src/db/schema.ts";
import { ensureReaderRole, runQuery, withoutFinalTerminators } from "../src/query.ts";
import { runTest, testDatabaseUrl } from "./support.ts";

const failureMessage = (query: string) =>
  runQuery({ sql: query }).pipe(
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
        sql: `select s.project_key, r.input_tokens as tokens, r.output_tokens as tokens, r.cost_usd
              from requests r join sessions s on s.id = r.session_id
              order by r.input_tokens -- cheapest first`,
        limit: 2,
      });
      expect(result).toEqual({
        columns: ["project_key", "tokens", "tokens", "cost_usd"],
        rows: [
          ["aqt", 10, 5, null],
          ["aqt", 20, 5, null],
        ],
        truncated: true,
      });
      expect(
        (yield* runQuery({
          sql: "select 9007199254740993::numeric, 999999999999999000::numeric, 0.5, ';--x'; -- exact",
        })).rows,
      ).toEqual([["9007199254740993", "999999999999999000", 0.5, ";--x"]]);
    }),
  );
});

test("queries cannot reach the tables behind the views, change anything or return too much", async () => {
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
          `select set_config('role', '${decodeURIComponent(new URL(testDatabaseUrl).username)}', true), query_to_xml('select * from public.api_tokens', true, false, '')`,
        ),
      ).toContain("permission denied");
      for (const smuggled of [
        "select 1) as q; delete from public.api_tokens; select (1",
        "select 1) as q) as numbered; delete from public.api_tokens; select * from ((select 1",
      ])
        expect(yield* failureMessage(smuggled)).not.toBe("succeeded");
      expect(yield* db.select().from(apiTokens)).toHaveLength(1);
      for (const large of [
        "select repeat('x', 1048576) from generate_series(1, 20)",
        "select repeat('x', 20000000)",
      ])
        expect(yield* failureMessage(large)).toContain("larger than 16 MB");
      const lookahead = yield* runQuery({
        sql: "select repeat('x', 9437184) as text from generate_series(1, 2)",
        limit: 1,
      });
      expect([lookahead.rows.length, lookahead.truncated]).toEqual([1, true]);
    }),
  );
});

test("only the semicolons that end the query are removed, whatever its literals and comments hold", () => {
  expect(withoutFinalTerminators("select ';--x', \"a;b\", $q$;$q$ ;; -- today's total")).toBe(
    "select ';--x', \"a;b\", $q$;$q$    -- today's total",
  );
  expect(withoutFinalTerminators("select E'\\';' /* ; */;")).toBe("select E'\\';' /* ; */ ");
  expect(withoutFinalTerminators("select 1; select 2")).toBe("select 1; select 2");
  expect(withoutFinalTerminators("select 1 as total$usd$;")).toBe("select 1 as total$usd$ ");
  expect(withoutFinalTerminators("select time'12:00\\';")).toBe("select time'12:00\\' ");
  const started = performance.now();
  withoutFinalTerminators(`select 1; ${"--".repeat(30_000)}'`);
  expect(withoutFinalTerminators(`select 1${";".repeat(60_000)}`)).toBe(
    `select 1${" ".repeat(60_000)}`,
  );
  expect(performance.now() - started).toBeLessThan(100);
});

test("a reader role with more than read access is not given a login", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* ensureReaderRole();
      const db = yield* Db;
      yield* db.execute(sql.raw(`ALTER ROLE ${readerRole} CREATEDB`));
      const refused = yield* ensureReaderRole().pipe(
        Effect.flip,
        Effect.ensuring(
          db.execute(sql.raw(`ALTER ROLE ${readerRole} NOCREATEDB`)).pipe(Effect.orDie),
        ),
      );
      expect(refused._tag).toBe("UnsafeReaderRole");
    }),
  );
});
