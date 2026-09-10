import { lstat, mkdir } from "node:fs/promises";

import { type } from "arktype";
import { $ } from "bun";

// ── Port ─────────────────────────────────────────────────────────

/** The slice of a project's package.json this scaffolder reads and rewrites. */
export const packageManifest = type({
  "name?": "string",
  "private?": "boolean",
  "type?": "'module' | 'commonjs'",
  "packageManager?": "string",
  "scripts?": "Record<string, string>",
  "dependencies?": "Record<string, string>",
  "devDependencies?": "Record<string, string>",
});
export type PackageManifest = typeof packageManifest.infer;

export interface ShellRunner {
  exists(path: string): Promise<boolean>;
  reserveDirectory(path: string): Promise<void>;
  /** Spawn a command with inherited stdio. Throws on non-zero exit. */
  spawn(command: string, args: string[], opts: { cwd: string }): Promise<void>;

  /** Install packages via bun add. */
  install(packages: string[], opts: { cwd: string; dev?: boolean }): Promise<void>;

  /** Create a directory (mkdir -p). */
  mkdir(path: string, cwd: string): Promise<void>;

  /** Write string content to a file. */
  writeFile(path: string, content: string): Promise<void>;

  readFile(path: string): Promise<string>;

  taskNames(cwd: string): Promise<string[]>;

  /** Read a project's package.json. */
  readPackageJson(path: string): Promise<PackageManifest>;
}

// ── Bun adapter ──────────────────────────────────────────────────

export class BunShellRunner implements ShellRunner {
  async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async reserveDirectory(path: string): Promise<void> {
    await mkdir(path);
  }

  async spawn(command: string, args: string[], opts: { cwd: string }): Promise<void> {
    const proc = Bun.spawn([command, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
      cwd: opts.cwd,
    });
    if ((await proc.exited) !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed with exit code ${proc.exitCode}`);
    }
  }

  async install(packages: string[], opts: { cwd: string; dev?: boolean }): Promise<void> {
    const args = opts.dev ? ["add", "-d", ...packages] : ["add", ...packages];
    await $`bun ${args}`.cwd(opts.cwd).quiet();
  }

  async mkdir(path: string, cwd: string): Promise<void> {
    await $`mkdir -p ${path}`.cwd(cwd).quiet();
  }

  async writeFile(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  }

  async readFile(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  async taskNames(cwd: string): Promise<string[]> {
    const proc = Bun.spawn(["mise", "tasks", "--json", "--hidden"], {
      cwd,
      stdout: "pipe",
      stderr: "inherit",
    });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error("Could not read workspace mise tasks.");
    const tasks = type({ name: "string", aliases: "string[]" }).array().assert(JSON.parse(output));
    return tasks.flatMap((task) => [task.name, ...task.aliases]);
  }

  async readPackageJson(path: string): Promise<PackageManifest> {
    return packageManifest.assert(await Bun.file(path).json());
  }
}
