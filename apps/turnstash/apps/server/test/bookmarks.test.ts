import { expect, setDefaultTimeout, test } from "bun:test";

import { BookmarkInput, NotFound } from "@aqt/turnstash-api";
import { type NormalizedConversation, emptyUsage, MachineId, sha256Hex } from "@aqt/turnstash-core";
import { normalizers } from "@aqt/turnstash-providers";
import { BunHttpClient, BunHttpServer } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { AuthLive } from "../src/auth.ts";
import { createBookmark, deleteBookmark, listBookmarks, updateBookmark } from "../src/bookmarks.ts";
import { deleteConversation } from "../src/conversations.ts";
import { Db } from "../src/db/client.ts";
import {
  apiTokens,
  bookmarks,
  conversationTurns,
  dirtyConversations,
  machines,
  messages,
  sourceRecords,
  sourceStreams,
} from "../src/db/schema.ts";
import { ApiLive } from "../src/http.ts";
import { exportMarkdown } from "../src/markdown-export.ts";
import { normalizeConversation, queueStale } from "../src/normalize.ts";
import { runTest, type TestServices } from "./support.ts";

setDefaultTimeout(30_000);
const at = "2026-10-03T10:00:00.000Z";
const conversationKey = "bookmark-fixture";
const firstKey = "first](\nmessage";

const normalized: NormalizedConversation = {
  conversationKey,
  title: "Useful [answer]\n# heading",
  startedAt: at,
  endedAt: at,
  messages: [
    {
      messageKey: "system",
      seq: 0,
      role: "system",
      createdAt: at,
      parts: [{ type: "text", text: "private system instructions" }],
      text: "private system instructions",
    },
    {
      messageKey: firstKey,
      seq: 1,
      role: "user",
      createdAt: at,
      parts: [{ type: "text", text: "First question" }],
      text: "First question",
    },
    {
      messageKey: "answer",
      seq: 2,
      role: "assistant",
      createdAt: at,
      parts: [
        { type: "thinking", text: "private thinking" },
        { type: "text", text: "First answer\n\n```ts\nconst n = 1;\n```" },
        { type: "tool_call", toolKey: "tool-1", name: "shell", input: { command: "echo ok" } },
        { type: "tool_result", toolKey: "tool-1", output: null },
      ],
      text: "First answer",
    },
    {
      messageKey: "second",
      seq: 3,
      role: "user",
      createdAt: at,
      parts: [{ type: "text", text: "Second question" }],
      text: "Second question",
    },
    {
      messageKey: "last",
      seq: 4,
      role: "assistant",
      createdAt: at,
      parts: [{ type: "text", text: "Second answer" }],
      text: "Second answer",
    },
  ],
  toolExecutions: [
    {
      toolKey: "tool-1",
      messageKey: "answer",
      name: "shell [output]",
      input: { command: "echo ok" },
      output: "tool output\n```\ninside fence",
      status: "ok",
    },
  ],
  requests: [],
};

const state = () => ({ value: normalized });
const overrides = (data: ReturnType<typeof state>) => ({
  pi: { ...normalizers.pi, normalize: () => data.value },
});

const seed = Effect.gen(function* () {
  const db = yield* Db;
  const machineId = MachineId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  yield* db.insert(machines).values({
    id: machineId,
    name: "test",
    os: "linux",
    arch: "x64",
    tokenHash: sha256Hex("machine"),
  });
  const [stream] = yield* db
    .insert(sourceStreams)
    .values({ machineId, provider: "pi", streamId: "fixture" })
    .returning({ id: sourceStreams.id });
  if (stream === undefined) return yield* Effect.die("missing stream");
  yield* db.insert(sourceRecords).values({
    streamRef: stream.id,
    provider: "pi",
    recordKey: "record",
    contentHash: "hash",
    payload: "already archived fixture",
    observedAt: new Date(at),
    conversationKey,
  });
  const id = yield* normalizeConversation("pi", conversationKey);
  if (id === null) return yield* Effect.die("missing conversation");
  return id;
});

test("bookmarks deduplicate targets, update notes, paginate and delete once", async () => {
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const input = BookmarkInput.make({
        conversationId: id,
        target: { kind: "turn", messageKey: "system" },
        note: "Useful fix",
      });
      const saved = yield* createBookmark(input);
      const duplicate = yield* createBookmark(input);
      expect(duplicate.id).toBe(saved.id);
      expect((yield* listBookmarks({})).items).toHaveLength(1);
      expect((yield* updateBookmark(saved.id, "Updated note")).note).toBe("Updated note");
      yield* createBookmark(
        BookmarkInput.make({ conversationId: id, target: { kind: "conversation" } }),
      );
      yield* createBookmark(
        BookmarkInput.make({ conversationId: id, target: { kind: "message", messageKey: "last" } }),
      );
      const page = yield* listBookmarks({ conversationId: id, limit: 2 });
      expect(page.items).toHaveLength(2);
      if (page.nextCursor === null) return yield* Effect.die("missing cursor");
      expect((yield* listBookmarks({ cursor: page.nextCursor, limit: 2 })).items).toHaveLength(1);
      yield* deleteBookmark(saved.id);
      const missing = yield* deleteBookmark(saved.id).pipe(Effect.flip);
      expect(missing).toBeInstanceOf(NotFound);
    }),
    overrides(state()),
  );
});

test("bookmarks survive reprocessing and are hidden once their target disappears", async () => {
  const data = state();
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const turn = yield* createBookmark(
        BookmarkInput.make({
          conversationId: id,
          target: { kind: "turn", messageKey: "system" },
          note: "Useful fix",
        }),
      );
      const message = yield* createBookmark(
        BookmarkInput.make({ conversationId: id, target: { kind: "message", messageKey: "last" } }),
      );
      yield* normalizeConversation("pi", conversationKey);
      expect((yield* listBookmarks({})).items.find((item) => item.id === turn.id)).toMatchObject({
        note: "Useful fix",
        available: true,
      });
      data.value = {
        ...normalized,
        messages: normalized.messages.filter((item) => item.messageKey !== "last"),
      };
      yield* normalizeConversation("pi", conversationKey);
      expect((yield* listBookmarks({})).items.map((item) => item.id)).not.toContain(message.id);
    }),
    overrides(data),
  );
});

test("deleting a conversation deletes its bookmarks", async () => {
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const saved = yield* createBookmark(
        BookmarkInput.make({ conversationId: id, target: { kind: "conversation" } }),
      );
      yield* deleteConversation(id);
      const db = yield* Db;
      expect(yield* db.select().from(bookmarks).where(eq(bookmarks.id, saved.id))).toEqual([]);
    }),
    overrides(state()),
  );
});

test("Markdown exports selected turns and messages with safe source links, preserved code and opt-in tool output", async () => {
  const data = state();
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const whole = yield* exportMarkdown(id, {
        selection: { kind: "conversation" },
        sourceOrigin: "https://turnstash.test",
      });
      expect(whole.markdown).toContain("# Useful \\[answer\\] \\# heading");
      expect(whole.markdown).toContain("Second answer");
      for (const excluded of [
        "private system instructions",
        "private thinking",
        "tool output",
        "echo ok",
      ])
        expect(whole.markdown).not.toContain(excluded);
      const turn = yield* exportMarkdown(id, {
        selection: { kind: "turns", messageKeys: [firstKey] },
        sourceOrigin: "https://turnstash.test",
      });
      expect(turn.markdown).toContain("First question");
      expect(turn.markdown).toContain("First answer\n\n```ts\nconst n = 1;\n```");
      expect(turn.markdown).not.toContain("Second question");
      expect(turn.markdown).not.toContain("Second answer");
      expect(turn.markdown).toContain(
        `https://turnstash.test/conversations/${id}?message=first%5D%28%0Amessage`,
      );
      const selected = yield* exportMarkdown(id, {
        selection: { kind: "messages", messageKeys: ["answer"] },
        includeTools: true,
      });
      expect(selected.markdown).not.toContain("First question");
      expect(selected.markdown).not.toContain("private thinking");
      expect(selected.markdown).toContain('"command": "echo ok"');
      expect(selected.markdown).toContain("````\ntool output\n```\ninside fence\n````");
      expect(selected.markdown).toContain("Tool output: shell \\[output\\]");
      const missing = yield* exportMarkdown(id, {
        selection: { kind: "messages", messageKeys: ["missing"] },
      }).pipe(Effect.flip);
      expect(missing._tag).toBe("BadRequest");
    }),
    overrides(data),
  );
});

test("selected turn exports retain interleaved subagent messages and backfill archived ownership", async () => {
  const data = state();
  data.value = {
    ...normalized,
    messages: [
      {
        messageKey: "m0",
        seq: 0,
        role: "user",
        createdAt: at,
        parts: [{ type: "text", text: "Delegate the first task" }],
        text: "Delegate the first task",
      },
      {
        messageKey: "m1",
        seq: 1,
        role: "assistant",
        createdAt: at,
        parts: [
          {
            type: "tool_call",
            toolKey: "spawn",
            name: "Agent",
            input: { prompt: "Delegated prompt" },
          },
        ],
        text: "",
      },
      {
        messageKey: "m2",
        seq: 2,
        role: "user",
        createdAt: at,
        parts: [{ type: "text", text: "Second top-level prompt" }],
        text: "Second top-level prompt",
      },
      {
        messageKey: "m3",
        seq: 3,
        role: "assistant",
        createdAt: at,
        parts: [{ type: "text", text: "Second top-level answer" }],
        text: "Second top-level answer",
      },
      {
        messageKey: "m4",
        seq: 4,
        role: "user",
        parentMessageKey: "m1",
        createdAt: at,
        parts: [{ type: "text", text: "Delegated prompt" }],
        text: "Delegated prompt",
      },
      {
        messageKey: "m5",
        seq: 5,
        role: "assistant",
        parentMessageKey: "m4",
        createdAt: at,
        parts: [{ type: "text", text: "Delegated answer" }],
        text: "Delegated answer",
      },
    ],
    toolExecutions: [],
    requests: ["m1", "m3", "m5"].map((messageKey) => ({
      messageKey,
      requestKey: messageKey,
      modelRaw: "test-model",
      requestedAt: at,
      usage: emptyUsage,
      usageBasis: "reported",
    })),
  };
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const db = yield* Db;
      const ownership = () =>
        db
          .select({ messageKey: messages.messageKey, turnIndex: messages.turnIndex })
          .from(messages)
          .where(eq(messages.conversationId, id))
          .orderBy(messages.seq);
      const expected = [0, 0, 1, 1, 0, 0];
      expect((yield* ownership()).map((row) => row.turnIndex)).toEqual(expected);
      const first = yield* exportMarkdown(id, {
        selection: { kind: "turns", messageKeys: ["m0"] },
      });
      expect(first.markdown).toContain("Delegate the first task");
      expect(first.markdown).toContain("Delegated prompt");
      expect(first.markdown).toContain("Delegated answer");
      expect(first.markdown).not.toContain("Second top-level");
      const second = yield* exportMarkdown(id, {
        selection: { kind: "turns", messageKeys: ["m2"] },
      });
      expect(second.markdown).toContain("Second top-level prompt");
      expect(second.markdown).toContain("Second top-level answer");
      expect(second.markdown).not.toContain("Delegated");
      yield* db.update(messages).set({ turnIndex: null }).where(eq(messages.conversationId, id));
      yield* db
        .update(conversationTurns)
        .set({ analysisVersion: 2 })
        .where(eq(conversationTurns.conversationId, id));
      const unavailable = yield* exportMarkdown(id, {
        selection: { kind: "turns", messageKeys: ["m0"] },
      }).pipe(Effect.flip);
      expect(unavailable._tag).toBe("BadRequest");
      expect(yield* queueStale()).toBe(1);
      expect(yield* db.select().from(dirtyConversations)).toHaveLength(1);
      yield* normalizeConversation("pi", conversationKey);
      expect((yield* ownership()).map((row) => row.turnIndex)).toEqual(expected);
    }),
    overrides(data),
  );
});

test("bookmark routes enforce read/admin scopes and reject invalid targets and source origins", async () => {
  const data = state();
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const db = yield* Db;
      yield* db.insert(apiTokens).values([
        { name: "read", tokenHash: sha256Hex("reader"), scopes: ["read"] },
        { name: "admin", tokenHash: sha256Hex("scoped-admin"), scopes: ["admin"] },
        { name: "none", tokenHash: sha256Hex("unscoped"), scopes: [] },
      ]);
      const services = yield* Effect.context<TestServices>();
      const web = HttpRouter.toWebHandler(
        ApiLive.pipe(
          Layer.provide(AuthLive),
          Layer.provideMerge(Layer.succeedContext(services)),
          Layer.provideMerge(BunHttpClient.layer),
          Layer.provide(BunHttpServer.layerHttpServices),
        ),
        { disableLogger: true },
      );
      yield* Effect.promise(async () => {
        const request = (
          path: string,
          token: string,
          method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
          body?: unknown,
        ) =>
          web.handler(
            new Request(`http://turnstash.test/api${path}`, {
              method,
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
        const input = { conversationId: id, target: { kind: "message", messageKey: "answer" } };
        expect((await request("/bookmarks", "reader")).status).toBe(200);
        expect((await request("/bookmarks", "scoped-admin")).status).toBe(200);
        expect((await request("/bookmarks", "scoped-admin", "POST", input)).status).toBe(200);
        expect((await request("/bookmarks", "unscoped")).status).toBe(401);
        expect((await request("/bookmarks", "unscoped", "POST", input)).status).toBe(401);
        expect((await request("/bookmarks", "machine")).status).toBe(401);
        expect((await request("/bookmarks", "reader", "POST", input)).status).toBe(401);
        expect(
          (
            await request(`/conversations/${id}/export`, "reader", "POST", {
              selection: { kind: "messages", messageKeys: ["answer"] },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await request("/bookmarks", "admin-secret", "POST", {
              ...input,
              target: { kind: "message", messageKey: "missing" },
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await request("/bookmarks", "admin-secret", "POST", {
              ...input,
              target: { kind: "turn", messageKey: "answer" },
            })
          ).status,
        ).toBe(400);
        const created = await request("/bookmarks", "admin-secret", "POST", input);
        expect(created.status).toBe(200);
        const saved = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
          await created.json(),
        );
        expect(
          (await request(`/bookmarks/${saved.id}`, "reader", "PATCH", { note: "edit" })).status,
        ).toBe(401);
        expect((await request(`/bookmarks/${saved.id}`, "reader", "DELETE")).status).toBe(401);
        expect(
          (await request(`/bookmarks/${saved.id}`, "admin-secret", "PATCH", { note: "edit" }))
            .status,
        ).toBe(200);
        expect((await request(`/bookmarks/${saved.id}`, "admin-secret", "DELETE")).status).toBe(
          204,
        );
        expect(
          (
            await request(`/conversations/${id}/export`, "reader", "POST", {
              selection: { kind: "conversation" },
              sourceOrigin: "javascript:bad",
            })
          ).status,
        ).toBe(400);
      }).pipe(Effect.ensuring(Effect.promise(() => web.dispose())));
    }),
    overrides(data),
  );
});
