import { describe, expect, test } from "bun:test";

import type { Config } from "../config.ts";
import { scaffold, NEXT_GENERATOR, SHADCN_CLI } from "../pipeline.ts";
import { packageManifest, type PackageManifest, type ShellRunner } from "../shell.ts";

const ROOT = "/workspace";
const APP = `${ROOT}/apps/example`;
const config: Config = {
  projectName: "example",
  shadcn: true,
  shadcnComponents: ["input"],
  hono: true,
  themes: true,
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
  ]);
  calls: { command: string; args: string[]; cwd: string }[] = [];
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
          dependencies: { next: "16.3.4" },
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
  async mkdir(_path: string, _cwd: string) {}
  async writeFile(path: string, content: string) {
    this.files.set(path, content);
  }
  async readPackageJson(path: string): Promise<PackageManifest> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return packageManifest.assert(JSON.parse(content));
  }
}
const step = async (_label: string, fn: () => Promise<void>) => fn();

describe("workspace scaffold", () => {
  test("creates an app with shared tooling, Base UI, ArkType, and root CI", async () => {
    const shell = new RecordingShell();
    await scaffold(config, shell, step, ROOT);
    const create = shell.calls[0]!;
    expect(create.cwd).toBe(ROOT);
    expect(create.args).toContain(APP);
    for (const flag of ["--disable-git", "--skip-install", "--no-eslint", "--react-compiler"])
      expect(create.args).toContain(flag);
    const pkg = await shell.readPackageJson(`${APP}/package.json`);
    expect(pkg.name).toBe("@aqt/example");
    expect(pkg.devDependencies?.["@aqt/config"]).toBe("workspace:*");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.dependencies?.next).toBe("16.3.4");
    expect(pkg.scripts?.check).toContain("bun run test");
    expect(pkg.scripts?.typecheck).toContain("next typegen");
    expect(shell.calls.some((c) => c.command === "git")).toBe(false);
    expect(shell.calls.some((c) => c.args.includes("arktype"))).toBe(true);
    expect(shell.calls.some((c) => c.args.includes("@hono/standard-validator"))).toBe(true);
    const init = shell.calls.find((c) => c.args.includes(SHADCN_CLI) && c.args.includes("init"));
    expect(init?.args).toContain("base");
    expect(init?.args).toContain("--no-monorepo");
    expect(shell.files.has(`${ROOT}/.github/workflows/example.yml`)).toBe(true);
    expect(shell.files.has(`${APP}/.github/workflows/ci.yml`)).toBe(false);
    expect(shell.calls.at(-1)?.args).toEqual(["run", "build"]);
    expect(shell.calls.some((c) => c.args[0] === "install" && c.cwd === ROOT)).toBe(true);
    const commands = JSON.stringify(shell.calls);
    for (const obsolete of ["prettier", "valibot", "git", "--eslint"])
      expect(commands).not.toContain(`"${obsolete}"`);
  });

  test("minimal app skips optional tooling without leaving a test command", async () => {
    const shell = new RecordingShell();
    await scaffold(
      { ...config, shadcn: false, hono: false, themes: false, testing: false, ci: false },
      shell,
      step,
      ROOT,
    );
    const pkg = await shell.readPackageJson(`${APP}/package.json`);
    expect(pkg.scripts?.test).toBeUndefined();
    expect(pkg.scripts?.check).not.toContain("bun run test");
    expect(shell.calls.some((c) => c.args.includes(SHADCN_CLI))).toBe(false);
    expect(shell.files.has(`${ROOT}/.github/workflows/example.yml`)).toBe(false);
    expect(shell.files.has(`${APP}/src/lib/hono/index.ts`)).toBe(false);
  });

  test.each(["../escape", "foo/bar", "-flag", "Foo", "@aqt/foo", "", "foo;rm", "foo\nbar"])(
    "rejects invalid name %j before writing",
    async (projectName) => {
      const shell = new RecordingShell();
      await expect(scaffold({ ...config, projectName }, shell, step, ROOT)).rejects.toThrow();
      expect(shell.calls).toHaveLength(0);
      expect(shell.files.size).toBe(2);
    },
  );

  test.each([APP, `${ROOT}/.github/workflows/example.yml`])(
    "preserves existing destination %s",
    async (path) => {
      const shell = new RecordingShell();
      shell.files.set(path, "keep me");
      await expect(scaffold(config, shell, step, ROOT)).rejects.toThrow("already exists");
      expect(shell.files.get(path)).toBe("keep me");
      expect(shell.calls).toHaveLength(0);
    },
  );

  test("rejects a non-aqt workspace", async () => {
    const shell = new RecordingShell();
    shell.files.set(`${ROOT}/package.json`, '{"name":"elsewhere"}');
    await expect(scaffold(config, shell, step, ROOT)).rejects.toThrow("aqt workspace");
    expect(shell.calls).toHaveLength(0);
  });

  test("propagates failed commands instead of reporting success", async () => {
    class FailingShell extends RecordingShell {
      override async spawn() {
        throw new Error("generator failed");
      }
    }
    await expect(scaffold(config, new FailingShell(), step, ROOT)).rejects.toThrow(
      "generator failed",
    );
  });
});
