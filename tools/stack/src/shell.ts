import { $ } from "bun";

// ── Port ─────────────────────────────────────────────────────────

/** The slice of a project's package.json this scaffolder reads and rewrites. */
export interface PackageManifest {
  scripts?: Record<string, string>;
}

export interface ShellRunner {
  /** Spawn a command with inherited stdio. Throws on non-zero exit. */
  spawn(command: string, args: string[], opts: { cwd: string }): Promise<void>;

  /** Install packages via bun add. */
  install(packages: string[], opts: { cwd: string; dev?: boolean }): Promise<void>;

  /** Create a directory (mkdir -p). */
  mkdir(path: string, cwd: string): Promise<void>;

  /** Write string content to a file. */
  writeFile(path: string, content: string): Promise<void>;

  /** Read a file as text. */
  readFile(path: string): Promise<string>;

  /** Read a project's package.json. */
  readPackageJson(path: string): Promise<PackageManifest>;
}

// ── Bun adapter ──────────────────────────────────────────────────

export class BunShellRunner implements ShellRunner {
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

  async readPackageJson(path: string): Promise<PackageManifest> {
    return Bun.file(path).json();
  }
}
