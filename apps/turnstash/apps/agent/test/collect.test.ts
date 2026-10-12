import { expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";

import { type HostEnv, MachineId, type SourceProvider } from "@aqt/turnstash-core";
import { copilotNormalizer, copilotSource, normalizers } from "@aqt/turnstash-providers";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer, Option } from "effect";

import { collect } from "../src/collect.ts";
import { Providers, providersLayer } from "../src/providers.ts";
import { AgentState } from "../src/state.ts";
import { withDirectory } from "./support.ts";

const host: HostEnv = { os: "darwin", home: "/home/test", env: {} };

test("saved Copilot chats use snapshot extraction, redaction and content deduplication", () =>
  withDirectory(async (directory) => {
    const root = join(directory, "workspaces");
    const file = join(root, "workspace", "chatSessions", "session-1.json");
    const turn = {
      requestId: "r1",
      message: { text: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
      response: [{ value: "Answer" }],
    };
    const session = {
      sessionId: "session-1",
      creationDate: Date.parse("2026-06-01T10:00:00Z"),
      responderUsername: "GitHub Copilot",
      requests: [turn],
      editorState: "x".repeat(9 * 1024 * 1024),
    };
    await Bun.write(file, JSON.stringify(session));
    const localHost: HostEnv = {
      os: "linux",
      home: "",
      env: {
        TURNSTASH_COPILOT_SESSION_STATE_DIR: "",
        TURNSTASH_COPILOT_SESSION_STORE_DB: "",
        TURNSTASH_COPILOT_GLOBAL_STORAGE_DIR: "",
        TURNSTASH_COPILOT_WORKSPACE_STORAGE_DIR: root,
      },
    };
    const layer = Layer.mergeAll(
      BunServices.layer,
      AgentState.layer(join(directory, "state.db")),
      providersLayer([copilotSource], normalizers),
    );
    const run = <A, E>(
      effect: Effect.Effect<A, E, AgentState.Service | Providers | BunServices.BunServices>,
    ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
    const first = await run(collect({ host: localHost }));
    expect(first.errors).toEqual([]);
    expect(first.records).toBe(2);
    expect((await run(collect({ host: localHost }))).records).toBe(0);
    turn.response = [{ value: "Updated answer" }];
    await Bun.write(file, JSON.stringify(session));
    expect((await run(collect({ host: localHost }))).records).toBe(1);
    const batch = await run(
      Effect.flatMap(AgentState.Service, (state) =>
        state.claimBatch({
          batchId: "0b1d6e6c-6c3d-4f79-9d46-6f3ed0c4a0f1",
          machineId: MachineId.make("d4aa4082-eaf3-4de6-acb0-23985c26d539"),
          agentVersion: "test",
        }),
      ),
    );
    expect(batch.records.every((record) => record.payload.length < 1000)).toBe(true);
    expect(batch.records.some((record) => record.payload.includes("sk-ant-"))).toBe(false);
    const conversation = copilotNormalizer.normalize("vscode:session-1", batch.records);
    expect(conversation?.messages[0]?.text).toBe("key [REDACTED]");
    expect(conversation?.messages[1]?.text).toBe("Updated answer");
  }));

const fakeSource = (rootPath: string): SourceProvider => ({
  id: "claude",
  roots: () => [{ path: rootPath, label: "test" }],
  discover: (root) =>
    Effect.succeed([
      { kind: "jsonl", root, relativePath: "session.jsonl" },
      { kind: "json", root, relativePath: "meta.json" },
    ]),
});

const layers = (rootPath: string, statePath: string) =>
  Layer.mergeAll(
    BunServices.layer,
    AgentState.layer(statePath),
    Layer.succeed(Providers, {
      sources: [fakeSource(rootPath)],
      conversationKeyOf: (_provider, _streamId, payload) => {
        const parsed: unknown = JSON.parse(payload);
        return typeof parsed === "object" &&
          parsed !== null &&
          "sessionId" in parsed &&
          typeof parsed.sessionId === "string"
          ? Option.some(parsed.sessionId)
          : Option.none();
      },
    }),
  );

const runWith =
  (rootPath: string, statePath: string) =>
  <A, E>(effect: Effect.Effect<A, E, AgentState.Service | Providers | BunServices.BunServices>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layers(rootPath, statePath))));

test("collect enqueues new records once, resumes from the checkpoint and redacts secrets", () =>
  withDirectory(async (directory) => {
    const root = join(directory, "root");
    await Bun.write(
      join(root, "session.jsonl"),
      '{"sessionId":"s1","text":"key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}\n{"sessionId":"s1","text":"two"}\n',
    );
    await Bun.write(join(root, "meta.json"), '{"title":"hello"}');
    const statePath = join(directory, "state.db");
    const run = runWith(root, statePath);

    const first = await run(collect({ host }));
    expect(first.records).toBe(3);
    expect(first.errors).toEqual([]);
    expect(first.byProvider.claude).toEqual({ streams: 2, records: 3 });

    const second = await run(collect({ host }));
    expect(second.records).toBe(0);

    await Bun.write(
      join(root, "session.jsonl"),
      '{"sessionId":"s1","text":"key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}\n{"sessionId":"s1","text":"two"}\n{"sessionId":"s2","text":"three"}\n',
    );
    const third = await run(collect({ host }));
    expect(third.records).toBe(1);

    const payloads = await run(
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        const batch = yield* state.claimBatch({
          batchId: "0b1d6e6c-6c3d-4f79-9d46-6f3ed0c4a0f1",
          machineId: MachineId.make("d4aa4082-eaf3-4de6-acb0-23985c26d539"),
          agentVersion: "test",
        });
        return batch.records.map((record) => [record.payload, record.redactions] as const);
      }),
    );
    expect(payloads).toHaveLength(4);
    expect(payloads[0]).toEqual(['{"sessionId":"s1","text":"key [REDACTED]"}', 1]);
    expect(payloads.some(([payload]) => payload.includes("sk-ant-"))).toBe(false);
  }));

test("sources whose size and mtime are unchanged are not read again", () =>
  withDirectory(async (directory) => {
    const root = join(directory, "root");
    const settled = new Date(Date.now() - 60_000);
    const write = async (name: string, content: string, mtime: Date) => {
      await Bun.write(join(root, name), content);
      await utimes(join(root, name), mtime, mtime);
    };
    await write("session.jsonl", '{"sessionId":"s1","text":"one"}\n', settled);
    await write("meta.json", '{"title":"aaaa"}', settled);
    const statePath = join(directory, "state.db");
    const run = runWith(root, statePath);

    expect((await run(collect({ host }))).records).toBe(2);
    await write("meta.json", '{"title":"bbbb"}', settled);
    expect((await run(collect({ host }))).records).toBe(0);
    await write("meta.json", '{"title":"bbbb"}', new Date(settled.getTime() + 1000));
    expect((await run(collect({ host }))).records).toBe(1);
  }));

test("collection reopens saved prefix digests and uploads changed heads of larger JSONL rewrites", () =>
  withDirectory(async (directory) => {
    const root = join(directory, "root");
    const file = join(root, "session.jsonl");
    const first = '{"sessionId":"s1","text":"one"}\n';
    await Bun.write(file, first);
    await Bun.write(join(root, "meta.json"), "{}");
    const run = runWith(root, join(directory, "state.db"));
    expect((await run(collect({ host }))).records).toBe(2);
    await Bun.write(file, `${first}{"sessionId":"s1","text":"two"}\n`);
    expect((await run(collect({ host }))).records).toBe(1);

    const replacement = '{"sessionId":"s1","text":"a much longer rewritten first message"}';
    await Bun.write(file, `${replacement}\n{"sessionId":"s1","text":"three"}\n`);
    const rewritten = await run(collect({ host }));
    expect(rewritten.errors).toEqual([]);
    expect(rewritten.records).toBe(2);
    expect((await run(collect({ host }))).records).toBe(0);
    const batch = await run(
      Effect.flatMap(AgentState.Service, (state) =>
        state.claimBatch({
          batchId: "0b1d6e6c-6c3d-4f79-9d46-6f3ed0c4a0f1",
          machineId: MachineId.make("d4aa4082-eaf3-4de6-acb0-23985c26d539"),
          agentVersion: "test",
        }),
      ),
    );
    expect(
      batch.records.find(
        (record) => String(record.recordKey) === "0" && record.payload.includes("s1"),
      )?.payload,
    ).toBe(replacement);
  }));

test("tombstoned conversations and dry runs never reach the outbox", () =>
  withDirectory(async (directory) => {
    const root = join(directory, "root");
    await Bun.write(
      join(root, "session.jsonl"),
      '{"sessionId":"dead","text":"gone"}\n{"sessionId":"alive","text":"kept"}\n',
    );
    await Bun.write(join(root, "meta.json"), "{}");
    const statePath = join(directory, "state.db");
    const run = runWith(root, statePath);

    const dry = await run(collect({ host, dryRun: true }));
    expect(dry.records).toBe(3);
    expect(await run(Effect.flatMap(AgentState.Service, (state) => state.pendingCount()))).toBe(0);

    await run(
      Effect.flatMap(AgentState.Service, (state) =>
        state.addTombstones([{ provider: "claude", conversationKey: "dead" }]),
      ),
    );
    const real = await run(collect({ host }));
    expect(real.records).toBe(2);
    expect(await run(Effect.flatMap(AgentState.Service, (state) => state.pendingCount()))).toBe(2);
  }));
