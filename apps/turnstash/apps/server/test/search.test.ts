import { expect, test } from "bun:test";

import { Effect } from "effect";

import { getMessages } from "../src/conversations.ts";
import { Db } from "../src/db/client.ts";
import { conversations, messages, modelRequests, toolExecutions } from "../src/db/schema.ts";
import { search } from "../src/search.ts";
import { runTest } from "./support.ts";

test("search combines project and role with provider and message date filters", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const at = new Date("2026-09-21T10:00:00Z");
      const first = crypto.randomUUID();
      const otherProject = crypto.randomUUID();
      const otherProvider = crypto.randomUUID();
      const projectless = crypto.randomUUID();
      yield* db.insert(conversations).values([
        {
          id: first,
          provider: "claude",
          projectKey: "project / one",
          conversationKey: first,
          startedAt: at,
          endedAt: at,
          parserVersion: 1,
        },
        {
          id: otherProject,
          provider: "claude",
          projectKey: "other",
          conversationKey: otherProject,
          startedAt: at,
          endedAt: at,
          parserVersion: 1,
        },
        {
          id: otherProvider,
          provider: "codex",
          projectKey: "project / one",
          conversationKey: otherProvider,
          startedAt: at,
          endedAt: at,
          parserVersion: 1,
        },
        {
          id: projectless,
          provider: "claude",
          conversationKey: projectless,
          startedAt: at,
          endedAt: at,
          parserVersion: 1,
        },
      ]);
      yield* db.insert(messages).values([
        {
          conversationId: first,
          messageKey: "matched / &?#",
          seq: 0,
          role: "assistant",
          createdAt: at,
          parts: [],
          text: "find the compass",
        },
        {
          conversationId: first,
          messageKey: "user",
          seq: 1,
          role: "user",
          createdAt: at,
          parts: [],
          text: "find the compass",
        },
        {
          conversationId: first,
          messageKey: "older",
          seq: 2,
          role: "assistant",
          createdAt: new Date("2026-08-21T10:00:00Z"),
          parts: [],
          text: "find the compass",
        },
        {
          conversationId: otherProject,
          messageKey: "other-project",
          seq: 0,
          role: "assistant",
          createdAt: at,
          parts: [],
          text: "find the compass",
        },
        {
          conversationId: otherProvider,
          messageKey: "other-provider",
          seq: 0,
          role: "assistant",
          createdAt: at,
          parts: [],
          text: "find the compass",
        },
        {
          conversationId: projectless,
          messageKey: "projectless",
          seq: 0,
          role: "assistant",
          createdAt: at,
          parts: [],
          text: "find the compass",
        },
      ]);
      expect((yield* search({ q: "compass" })).hits).toHaveLength(6);
      const result = yield* search({
        q: "compass",
        projectKey: "project / one",
        role: "assistant",
        provider: "claude",
        from: "2026-09-21",
        to: "2026-09-21",
      });
      expect(result.hits.map((hit) => hit.messageKey)).toEqual(["matched / &?#"]);
      expect(result.hits[0]?.snippet).toBe("find the <b>compass</b>");
      expect((yield* search({ q: "compass", projectKey: "missing" })).hits).toEqual([]);
      expect(
        (yield* search({ q: "compass", projectKey: "unknown" })).hits.map((hit) => hit.messageKey),
      ).toEqual(["projectless"]);
      expect(
        (yield* search({ q: "compass", role: "user" })).hits.map((hit) => hit.messageKey),
      ).toEqual(["user"]);
    }),
  );
});

test("stable message links seek into a transcript and paginate surrounding context", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const id = crypto.randomUUID();
      const at = new Date("2026-09-21T10:00:00Z");
      const count = 20;
      const target = "10 / & ? # +";
      const key = (index: number) => (index === 10 ? target : `message-${index}`);
      yield* db.insert(conversations).values({
        id,
        provider: "claude",
        conversationKey: id,
        startedAt: at,
        endedAt: at,
        parserVersion: 1,
      });
      yield* db.insert(messages).values(
        Array.from({ length: count }, (_, index) => ({
          conversationId: id,
          messageKey: key(index),
          seq: index * 3,
          role: "assistant" as const,
          createdAt: at,
          parts: [{ type: "text" as const, text: key(index) }],
          text: key(index),
        })),
      );
      yield* db.insert(modelRequests).values({
        conversationId: id,
        provider: "claude",
        messageKey: target,
        requestKey: "request",
        modelRaw: "claude-sonnet",
        modelId: "claude-sonnet",
        requestedAt: at,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        reasoningTokens: 0,
        usageBasis: "reported",
      });
      yield* db.insert(toolExecutions).values({
        conversationId: id,
        messageKey: target,
        toolKey: "tool",
        name: "read",
        output: "compass",
        status: "ok",
      });
      const page = yield* getMessages(id, undefined, 6, { message: target });
      expect(page.items.map((message) => message.messageKey)).toEqual(
        Array.from({ length: 6 }, (_, index) => key(7 + index)),
      );
      expect(
        page.items
          .find((message) => message.messageKey === target)
          ?.requests.map((request) => request.requestKey),
      ).toEqual(["request"]);
      expect(page.toolExecutions.map((tool) => tool.toolKey)).toEqual(["tool"]);
      const earlier = yield* getMessages(
        id,
        undefined,
        6,
        page.previousCursor === null ? {} : { before: page.previousCursor },
      );
      const later = yield* getMessages(id, page.nextCursor ?? undefined, 6);
      expect(earlier.items.map((message) => message.seq)).toEqual([3, 6, 9, 12, 15, 18]);
      expect(later.items.map((message) => message.seq)).toEqual([39, 42, 45, 48, 51, 54]);
      expect((yield* getMessages(id, undefined, 6, { message: key(0) })).previousCursor).toBeNull();
      expect(
        (yield* getMessages(id, undefined, 6, { message: key(count - 1) })).nextCursor,
      ).toBeNull();
      expect(
        (yield* getMessages(id, undefined, 1, { message: target })).items.map(
          (message) => message.messageKey,
        ),
      ).toEqual([target]);
      const missing = yield* getMessages(id, undefined, 6, { message: "missing" }).pipe(
        Effect.flip,
      );
      expect(missing).toMatchObject({ entity: "message", id: "missing" });
    }),
  );
});
