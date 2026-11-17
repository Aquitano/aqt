import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { resolve } from "node:path";

import type { Config } from "../config.ts";
import { scaffold, NEXT_GENERATOR } from "../pipeline.ts";
import { packageManifest, type PackageManifest, type ShellRunner } from "../shell.ts";

const ROOT = resolve("/workspace");
const APP = resolve(ROOT, "apps/example");
const WORKFLOW = resolve(ROOT, ".github/workflows/example.yml");
const TASKS = resolve(ROOT, "tools/tasks/example.toml");
const config: Config = {
  projectName: "example",
  hono: true,
  testing: true,
  ci: true,
};

class RecordingShell implements ShellRunner {
  files = new Map<string, string>([
    [
      `${ROOT}/package.json`,
      JSON.stringify({ name: "aqt", devDependencies: { typescript: "7.0.2" } }),
    ],
    [`${ROOT}/packages/ts/config/package.json`, "{}"],
    [
      `${ROOT}/mise.toml`,
      '[task_config]\nincludes = ["tools/tasks"]\n[tasks.check]\ndepends = ["*:check"]\n[tasks."ts:check"]\ndepends = ["*:ts"]\n[tasks."shared:ts"]\nrun = "true"\n',
    ],
  ]);
  calls: { command: string; args: string[]; cwd: string }[] = [];
  existingTasks = ["check", "ts:check", "shared:ts", "stack:check"];
  async taskNames() {
    return this.existingTasks;
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async reserveDirectory(path: string) {
    if (this.files.has(path)) throw new Error("Already exists");
    this.files.set(path, "");
  }
  async spawn(command: string, args: string[], opts: { cwd: string }) {
    this.calls.push({ command, args, cwd: opts.cwd });
    if (args.includes(NEXT_GENERATOR)) {
      this.files.set(
        `${APP}/package.json`,
        JSON.stringify({
          name: "example",
          dependencies: { next: "16.3.4", react: "19.2.8", "react-dom": "19.2.8" },
          devDependencies: { typescript: "^5", "babel-plugin-react-compiler": "1" },
        }),
      );
    }
  }
  async install(packages: string[], opts: { cwd: string; dev?: boolean }) {
    this.calls.push({
      command: "bun",
      args: ["add", ...(opts.dev ? ["-d"] : []), ...packages],
      cwd: opts.cwd,
    });
  }
  async mkdir() {}
  async writeFile(path: string, content: string) {
    this.files.set(path, content);
  }
  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return content;
  }
  async readPackageJson(path: string): Promise<PackageManifest> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return packageManifest.assert(JSON.parse(content));
  }
}
const step = async (_label: string, fn: () => Promise<void>) => fn();

describe("workspace scaffold", () => {
  test("creates an app with shared tooling, @aqt/ui, ArkType, and root CI", async () => {
    const shell = new RecordingShell();
    await scaffold(config, shell, step, ROOT);
    for (const arg of [APP, "--disable-git", "--skip-install"]) {
      expect(shell.calls[0]?.args).toContain(arg);
    }
    const pkg = await shell.readPackageJson(`${APP}/package.json`);
    expect(pkg.name).toBe("@aqt/example");
    expect(pkg.devDependencies?.["@aqt/config"]).toBe("workspace:*");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.dependencies?.next).toBe("16.3.4");
    expect(pkg.dependencies?.["@aqt/ui"]).toBe("workspace:*");
    expect(pkg.dependencies?.react).toBe("catalog:");
    expect(pkg.dependencies?.["react-dom"]).toBe("catalog:");
    expect(pkg.scripts?.check).toContain("bun run test");
    expect(shell.calls.some((c) => c.args.includes("arktype"))).toBe(true);
    expect(shell.calls.some((c) => c.args.includes("@hono/standard-validator"))).toBe(true);
    expect(shell.files.has(WORKFLOW)).toBe(true);
    expect(shell.calls.at(-1)?.args).toEqual(["run", "-n", "example:check"]);
    expect(shell.files.has(TASKS)).toBe(true);
    expect(shell.calls.some((c) => c.args[0] === "install" && c.cwd === ROOT)).toBe(true);
  });

  test("minimal app skips optional tooling without leaving a test command", async () => {
    const shell = new RecordingShell();
    const existingFragment = '["other:dev"]\nrun = "keep me"\n';
    shell.files.set(`${ROOT}/tools/tasks/other.toml`, existingFragment);
    shell.existingTasks.push("other:dev");
    await scaffold({ ...config, hono: false, testing: false, ci: false }, shell, step, ROOT);
    const pkg = await shell.readPackageJson(`${APP}/package.json`);
    expect(pkg.scripts?.test).toBeUndefined();
    expect(pkg.scripts?.check).not.toContain("bun run test");
    expect(shell.files.has(WORKFLOW)).toBe(false);
    expect(shell.files.has(TASKS)).toBe(true);
    expect(shell.files.get(`${ROOT}/tools/tasks/other.toml`)).toBe(existingFragment);
  });

  test.each(["../escape", "foo/bar", "-flag", "Foo", "@aqt/foo", "", "foo;rm", "foo\nbar"])(
    "rejects invalid name %j before writing",
    async (projectName) => {
      const shell = new RecordingShell();
      await rejects(scaffold({ ...config, projectName }, shell, step, ROOT));
      expect(shell.calls).toHaveLength(0);
      expect(shell.files.size).toBe(3);
    },
  );

  test.each([APP, WORKFLOW, TASKS])("preserves existing destination %s", async (path) => {
    const shell = new RecordingShell();
    shell.files.set(path, "keep me");
    await rejects(scaffold(config, shell, step, ROOT), /already exists/);
    expect(shell.files.get(path)).toBe("keep me");
    expect(shell.calls).toHaveLength(0);
  });

  test("rejects a non-aqt workspace", async () => {
    const shell = new RecordingShell();
    shell.files.set(`${ROOT}/package.json`, '{"name":"elsewhere"}');
    await rejects(scaffold(config, shell, step, ROOT), /aqt workspace/);
    expect(shell.calls).toHaveLength(0);
  });

  test.each(["stack", "ts", "shared", "check"])(
    "rejects reserved namespace %s",
    async (projectName) => {
      const shell = new RecordingShell();
      await rejects(
        scaffold({ ...config, projectName }, shell, step, ROOT),
        /namespace already exists/,
      );
      expect(shell.files.has(resolve(ROOT, "apps", projectName))).toBe(false);
      expect(shell.calls).toHaveLength(0);
    },
  );

  test("preserves tasks from other fragments and rejects their namespaces", async () => {
    const shell = new RecordingShell();
    shell.files.set(`${ROOT}/tools/tasks/other.toml`, '["example:dev"]\nrun = "keep me"\n');
    shell.existingTasks.push("example:dev");
    const before = new Map(shell.files);
    await rejects(scaffold(config, shell, step, ROOT), /namespace already exists/);
    expect(shell.files).toEqual(before);
    expect(shell.calls).toHaveLength(0);
  });

  test("rejects missing aggregate discovery before creating the app", async () => {
    const shell = new RecordingShell();
    shell.files.set(
      `${ROOT}/mise.toml`,
      (await shell.readFile(`${ROOT}/mise.toml`)).replace("*:ts", "stack:ts"),
    );
    await rejects(scaffold(config, shell, step, ROOT), /must discover/);
    expect(shell.files.has(APP)).toBe(false);
  });

  test("a failed build leaves the partial app outside aggregate checks", async () => {
    class BuildFailure extends RecordingShell {
      override async spawn(command: string, args: string[], opts: { cwd: string }) {
        if (args[0] === "run" && args[1] === "build") throw new Error("build failed");
        await super.spawn(command, args, opts);
      }
    }
    const shell = new BuildFailure();
    await rejects(scaffold(config, shell, step, ROOT), /build failed/);
    expect(shell.files.has(`${APP}/package.json`)).toBe(true);
    expect(shell.files.has(TASKS)).toBe(false);
  });
});
