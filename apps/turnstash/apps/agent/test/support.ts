import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

export const withDirectory = async (body: (path: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "turnstash-test-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const runCli = async (
  directory: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) => {
  const child = Bun.spawn(
    [process.execPath, new URL("../src/main.ts", import.meta.url).pathname, ...args],
    {
      env: {
        TURNSTASH_CONFIG_DIR: join(directory, "config"),
        TURNSTASH_STATE_DIR: join(directory, "state"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};
