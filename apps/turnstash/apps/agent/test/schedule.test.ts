import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeScheduleRunner } from "../src/schedule.ts";
import { run, withDirectory } from "./support.ts";

test("scheduled sync preserves selected paths, excludes credentials, and propagates the exit code", () =>
  withDirectory(async (directory) => {
    const configDir = join(directory, 'config with spaces " & $ %');
    const source = join(directory, "fake agent.js");
    await writeFile(
      source,
      `console.log(JSON.stringify({ args: process.argv.slice(2), env: process.env }))\nprocess.exit(17)\n`,
    );
    const environment = {
      TURNSTASH_CONFIG_DIR: configDir,
      TURNSTASH_STATE_DIR: join(directory, "state"),
      CODEX_HOME: join(directory, "codex"),
      CLAUDE_CONFIG_DIRS: `${directory}/claude-a,${directory}/claude-b`,
      OMP_SESSIONS_DIR: join(directory, "omp"),
      PATH: "/custom/bin",
      ADMIN_TOKEN: "must-not-be-saved",
      OPENAI_API_KEY: "must-not-be-saved-either",
    };
    const runner = await run(
      writeScheduleRunner(
        { os: "linux", home: directory, env: environment },
        { executable: process.execPath, script: source },
      ),
    );
    const result = Bun.spawnSync([runner.executable, runner.script], {
      env: { PATH: "/missing", HOME: "/missing", CODEX_HOME: "/wrong" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(17);
    const captured = JSON.parse(result.stdout.toString());
    expect(captured.args).toEqual(["sync"]);
    expect(captured.env).toMatchObject({
      HOME: directory,
      TURNSTASH_CONFIG_DIR: environment.TURNSTASH_CONFIG_DIR,
      TURNSTASH_STATE_DIR: environment.TURNSTASH_STATE_DIR,
      CODEX_HOME: environment.CODEX_HOME,
      CLAUDE_CONFIG_DIRS: environment.CLAUDE_CONFIG_DIRS,
      OMP_SESSIONS_DIR: environment.OMP_SESSIONS_DIR,
      PATH: environment.PATH,
    });
    expect(captured.env.ADMIN_TOKEN).toBeUndefined();
    expect(captured.env.OPENAI_API_KEY).toBeUndefined();
    expect(await readFile(runner.script, "utf8")).not.toContain("must-not-be-saved");
    expect((await stat(runner.script)).mode & 0o777).toBe(0o600);
  }));
