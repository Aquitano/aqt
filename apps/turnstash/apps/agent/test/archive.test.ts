import { expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Unauthorized } from "@aqt/turnstash-api";
import { Schema } from "effect";

import { runCli, withDirectory } from "./support.ts";

const machineId = "d4aa4082-eaf3-4de6-acb0-23985c26d539";
const sessionId = "5b0d4c55-1d5b-4f43-9a5e-2f7f3c1e8a10";
const cursor = `1759838400000|${sessionId}`;

const page = {
  items: [
    {
      id: sessionId,
      provider: "claude",
      conversationKey: "session-1",
      parentId: null,
      title: "Fix the pricing swap",
      projectKey: "code-aqt-turnstash",
      projectPath: "~/code/aqt-turnstash",
      gitBranch: "main",
      startedAt: "2026-10-07T12:00:00.000Z",
      endedAt: "2026-10-07T12:30:00.000Z",
      messageCount: 12,
      requestCount: 4,
      costUsd: 1.25,
      machineIds: [machineId],
    },
  ],
  nextCursor: cursor,
};

const machines = [
  {
    id: machineId,
    name: "laptop",
    os: "linux",
    arch: "x64",
    agentVersion: "0.7.0",
    enrolledAt: "2026-09-01T08:00:00.000Z",
    lastSeenAt: null,
    costUsd: 1.25,
    conversations: 1,
  },
];

const withServer = async (
  respond: (url: URL, request: Request) => Response,
  body: (server: string) => Promise<void>,
) => {
  const server = Bun.serve({ port: 0, fetch: (request) => respond(new URL(request.url), request) });
  try {
    await body(server.url.origin);
  } finally {
    await server.stop(true);
  }
};

// A file where the config and state directories should be makes every attempt to create them fail.
const blockCollectorState = (directory: string) =>
  Promise.all(["config", "state"].map((name) => writeFile(join(directory, name), "")));

test("sessions list pages the archive with a read token and leaves collector state alone", () =>
  withDirectory(async (directory) => {
    await blockCollectorState(directory);
    const requests: Array<{ path: string; query: object; authorization: string | null }> = [];
    await withServer(
      (url, request) => {
        requests.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          authorization: request.headers.get("authorization"),
        });
        return Response.json(url.pathname === "/api/machines" ? machines : page);
      },
      async (server) => {
        const result = await runCli(
          directory,
          [
            "sessions",
            "list",
            "--server",
            server,
            "--machine",
            "laptop",
            "--from",
            "2026-10-01",
            "--cursor",
            cursor,
            "--limit",
            "50",
            "--json",
          ],
          { TURNSTASH_READ_TOKEN: "fixture-read-token" },
        );
        expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
          exitCode: 0,
          stderr: "",
        });
        expect(JSON.parse(result.stdout)).toEqual(page);
      },
    );
    expect(requests).toEqual([
      { path: "/api/machines", query: {}, authorization: "Bearer fixture-read-token" },
      {
        path: "/api/conversations",
        query: { machineId, from: "2026-10-01", cursor, limit: "50" },
        authorization: "Bearer fixture-read-token",
      },
    ]);
    expect((await readdir(directory)).sort()).toEqual(["config", "state"]);
  }));

test("a token the read API refuses is explained without being printed", () =>
  withDirectory(async (directory) => {
    await withServer(
      () =>
        Response.json(Schema.encodeSync(Unauthorized)(new Unauthorized({ reason: "invalid" })), {
          status: 401,
        }),
      async (server) => {
        const result = await runCli(directory, [
          "sessions",
          "list",
          "--server",
          server,
          "--token",
          "fixture-machine-token",
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("the machine token used by sync cannot read the archive");
        expect(result.stdout + result.stderr).not.toContain("fixture-machine-token");
      },
    );
  }));

test("output longer than a pipe buffer reaches the reader in full", () =>
  withDirectory(async (directory) => {
    const markdown = "transcript line\n".repeat(16_384);
    await withServer(
      () => Response.json({ filename: "session.md", markdown }),
      async (server) => {
        const result = await runCli(
          directory,
          ["sessions", "export", sessionId, "--server", server],
          { TURNSTASH_READ_TOKEN: "fixture-read-token" },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`${markdown}\n`);
      },
    );
  }));
