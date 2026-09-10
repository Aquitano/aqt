import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { type } from "arktype";

import { buildMiseTasks, validateMiseNamespace } from "../mise.ts";
import { WORKSPACE_ROOT } from "../pipeline.ts";

const taskConfig = type({
  task_config: { includes: "string[]" },
  tasks: "Record<string, unknown>",
});
const taskDefinition = type({
  "depends?": "string[]",
  "wait_for?": "string[]",
  "run?": "string | string[]",
  "dir?": "string",
});
const marker = type({ task: "string", cwd: "string" });

async function rootConfig() {
  return Bun.file(resolve(WORKSPACE_ROOT, "mise.toml")).text();
}

describe("mise registration", () => {
  test("requires the task include and aggregate dependencies", async () => {
    const content = await rootConfig();
    expect(() => validateMiseNamespace(content, "example", [])).not.toThrow();
    for (const invalid of [
      content.replace('includes = ["tools/tasks"]', "includes = []"),
      content.replace('depends = ["*:check"]', "depends = []"),
      content.replace('depends = ["*:ts"]', "depends = []"),
      "",
      "invalid toml [",
    ]) {
      expect(() => validateMiseNamespace(invalid, "example", [])).toThrow();
    }
  });

  test.skipIf(!Bun.which("mise"))(
    "real mise discovers fragments, scopes apps, deduplicates checks, and resolves directories",
    async () => {
      const fixture = await realpath(await mkdtemp(resolve(tmpdir(), "aqt-mise-test-")));
      const env = {
        ...process.env,
        MISE_TRUSTED_CONFIG_PATHS: fixture,
        MISE_STATE_DIR: resolve(fixture, ".mise-state"),
        MISE_CACHE_DIR: resolve(fixture, ".mise-cache"),
      };
      try {
        const config = taskConfig.assert(Bun.TOML.parse(await rootConfig()));
        const directories: Promise<unknown>[] = [];
        const sections = ['[task_config]\nincludes = ["tools/tasks"]'];
        for (const [name, value] of Object.entries(config.tasks)) {
          const task = taskDefinition.assert(value);
          const lines = [`[tasks.${JSON.stringify(name)}]`];
          if (task.depends) lines.push(`depends = ${JSON.stringify(task.depends)}`);
          if (task.wait_for) lines.push(`wait_for = ${JSON.stringify(task.wait_for)}`);
          if (task.dir) {
            directories.push(mkdir(resolve(fixture, task.dir), { recursive: true }));
            lines.push(`dir = ${JSON.stringify(task.dir)}`);
          }
          if (task.run) lines.push(`run = ${JSON.stringify(`bun ${fixture}/marker.js ${name}`)}`);
          sections.push(lines.join("\n"));
        }
        await Promise.all(directories);
        await mkdir(resolve(fixture, "tools/tasks"), { recursive: true });
        await mkdir(resolve(fixture, "apps/example"), { recursive: true });
        await Bun.write(resolve(fixture, "mise.toml"), sections.join("\n\n"));
        await Bun.write(resolve(fixture, "tools/tasks/example.toml"), buildMiseTasks("example"));
        await Bun.write(
          resolve(fixture, "marker.js"),
          'import { appendFileSync } from "node:fs";\nappendFileSync(import.meta.dirname + "/markers.jsonl", JSON.stringify({task: process.argv[2], cwd: process.cwd()}) + "\\n");\n',
        );
        await Bun.write(
          resolve(fixture, "apps/example/package.json"),
          JSON.stringify({
            scripts: {
              check: "bun ../../marker.js example:ts",
              dev: "bun ../../marker.js example:dev",
            },
          }),
        );
        const run = async (task: string) => {
          await Bun.write(resolve(fixture, "markers.jsonl"), "");
          const proc = Bun.spawn(["mise", "run", task], {
            cwd: fixture,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exit] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          expect(exit, stdout + stderr).toBe(0);
          const lines = (await Bun.file(resolve(fixture, "markers.jsonl")).text())
            .trim()
            .split("\n");
          return lines.map((line) => marker.assert(JSON.parse(line)));
        };
        const all = await run("check");
        expect(all.map((entry) => entry.task).toSorted()).toEqual([
          "bank:go",
          "bank:ts",
          "example:ts",
          "gallery:ts",
          "health:kotlin",
          "health:ts",
          "img:ts",
          "notch:lint",
          "notch:test",
          "shared:ts",
          "stack:ts",
          "starboard:lint",
          "starboard:test",
          "workspace:check",
        ]);
        const ts = await run("ts:check");
        expect(ts.map((entry) => entry.task).toSorted()).toEqual([
          "bank:ts",
          "example:ts",
          "gallery:ts",
          "health:ts",
          "img:ts",
          "shared:ts",
          "stack:ts",
        ]);
        const app = await run("example:check");
        expect(app.map((entry) => entry.task).toSorted()).toEqual(["example:ts", "shared:ts"]);
        expect(app.find((entry) => entry.task === "example:ts")?.cwd).toBe(
          resolve(fixture, "apps/example"),
        );
        expect((await run("example:dev"))[0]?.cwd).toBe(resolve(fixture, "apps/example"));
        for (const native of ["bank:go", "health:kotlin"]) {
          // Each run resets the same marker file, so native checks must run serially.
          // oxlint-disable-next-line no-await-in-loop
          expect((await run(native)).map((entry) => entry.task)).toEqual([native]);
        }
        await Bun.write(
          resolve(fixture, "tools/tasks/other.toml"),
          '["existing:dev"]\nhide = true\nalias = "taken:dev"\nrun = "true"\n',
        );
        const listing = Bun.spawn(
          [
            process.execPath,
            "-e",
            `import { BunShellRunner } from ${JSON.stringify(resolve(WORKSPACE_ROOT, "tools/stack/src/shell.ts"))}; console.log(JSON.stringify(await new BunShellRunner().taskNames(process.cwd())));`,
          ],
          { cwd: fixture, env, stdout: "pipe", stderr: "pipe" },
        );
        const [names, errors, exit] = await Promise.all([
          new Response(listing.stdout).text(),
          new Response(listing.stderr).text(),
          listing.exited,
        ]);
        expect(exit, errors).toBe(0);
        const taskNames = type("string[]").assert(JSON.parse(names));
        for (const name of ["existing", "taken", "example"]) {
          expect(() => validateMiseNamespace(sections.join("\n\n"), name, taskNames)).toThrow(
            "namespace already exists",
          );
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
