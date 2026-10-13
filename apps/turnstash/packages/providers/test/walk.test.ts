import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Result } from "effect";
import { systemError } from "effect/PlatformError";

import { walkFiles } from "../src/walk.ts";

test("walking prunes excluded directories and depth before reading them", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnstash-walk-"));
  try {
    for (const name of ["node_modules", ".git", "deep", "deep/child"])
      await mkdir(join(root, name));
    for (const name of [
      "session.jsonl",
      "auth.json",
      "node_modules/skip.jsonl",
      ".git/skip.jsonl",
      "deep/child/skip.jsonl",
    ]) {
      await Bun.write(join(root, name), "{}");
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const visited: Array<string> = [];
        const files = yield* walkFiles({ path: root, label: "test" }, () => true, {
          maxDepth: 1,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (path, options) => {
              visited.push(path);
              return fs.readDirectory(path, options);
            },
          }),
        );
        expect(files.map((file) => file.relativePath)).toEqual(["session.jsonl"]);
        expect(visited).toEqual([root]);
        expect(
          yield* walkFiles({ path: join(root, "missing"), label: "missing" }, () => true),
        ).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const statError = (tag: "NotFound" | "PermissionDenied", path: string) =>
  systemError({ _tag: tag, module: "FileSystem", method: "stat", pathOrDescriptor: path });

test("walking skips vanished files but preserves permission errors", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const discover = (tag: "NotFound" | "PermissionDenied") =>
        walkFiles({ path: "/root", label: "test" }, () => true).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: () => Effect.succeed(["session"]),
            stat: () => Effect.fail(statError(tag, "/root/session")),
          }),
        );
      expect(yield* discover("NotFound")).toEqual([]);
      const result = yield* discover("PermissionDenied").pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure._tag).toBe("PlatformError");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

test("walking within subdirectories never stats the rest of the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnstash-walk-"));
  try {
    for (const name of ["sessions", "daemon"]) await mkdir(join(root, name));
    for (const name of ["sessions/a.jsonl", "daemon/updater.sock", "history.jsonl"])
      await Bun.write(join(root, name), "{}");
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = yield* walkFiles({ path: root, label: "test" }, () => true, {
          within: ["sessions", "archived_sessions"],
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (path) =>
              path.startsWith(join(root, "sessions"))
                ? fs.stat(path)
                : Effect.fail(statError("PermissionDenied", path)),
          }),
        );
        expect(files.map((file) => file.relativePath)).toEqual(["sessions/a.jsonl"]);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
