import { describe, expect, test, beforeEach } from "bun:test";

import type { PackageManifest, ShellRunner } from "../shell.ts";

// ── Recording test adapter ───────────────────────────────────────

interface ShellCall {
  kind: "spawn" | "install" | "mkdir" | "writeFile" | "readFile" | "readPackageJson";
  args: unknown[];
}

class RecordingShellRunner implements ShellRunner {
  calls: ShellCall[] = [];

  async spawn(command: string, args: string[], _opts: { cwd: string }): Promise<void> {
    this.calls.push({ kind: "spawn", args: [command, ...args] });
  }

  async install(packages: string[], opts: { cwd: string; dev?: boolean }): Promise<void> {
    this.calls.push({ kind: "install", args: [packages, opts.dev ?? false] });
  }

  async mkdir(path: string, _cwd: string): Promise<void> {
    this.calls.push({ kind: "mkdir", args: [path] });
  }

  async writeFile(path: string, _content: string): Promise<void> {
    this.calls.push({ kind: "writeFile", args: [path] });
  }

  async readFile(path: string): Promise<string> {
    this.calls.push({ kind: "readFile", args: [path] });
    return `content of ${path}`;
  }

  async readPackageJson(path: string): Promise<PackageManifest> {
    this.calls.push({ kind: "readPackageJson", args: [path] });
    return { scripts: {} };
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("RecordingShellRunner", () => {
  let shell: RecordingShellRunner;

  beforeEach(() => {
    shell = new RecordingShellRunner();
  });

  test("records spawn calls", async () => {
    await shell.spawn("bunx", ["create-next-app@latest", "--typescript"], { cwd: "/tmp" });

    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]!.kind).toBe("spawn");
    expect(shell.calls[0]!.args).toEqual(["bunx", "create-next-app@latest", "--typescript"]);
  });

  test("records install calls with dev flag", async () => {
    await shell.install(["prettier", "prettier-plugin-tailwindcss"], {
      cwd: "/tmp",
      dev: true,
    });

    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]!.kind).toBe("install");
    expect(shell.calls[0]!.args).toEqual([["prettier", "prettier-plugin-tailwindcss"], true]);
  });

  test("records install calls without dev flag", async () => {
    await shell.install(["hono"], { cwd: "/tmp" });

    expect(shell.calls[0]!.args).toEqual([["hono"], false]);
  });

  test("records mkdir calls", async () => {
    await shell.mkdir("/tmp/project/src/lib", "/tmp");

    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]!.kind).toBe("mkdir");
  });

  test("records writeFile calls", async () => {
    await shell.writeFile("/tmp/foo.ts", "content");

    expect(shell.calls[0]!.kind).toBe("writeFile");
  });

  test("records multiple calls in order", async () => {
    await shell.spawn("echo", ["hello"], { cwd: "/tmp" });
    await shell.install(["pkg"], { cwd: "/tmp" });
    await shell.writeFile("/tmp/out.txt", "done");

    expect(shell.calls).toHaveLength(3);
    expect(shell.calls[0]!.kind).toBe("spawn");
    expect(shell.calls[1]!.kind).toBe("install");
    expect(shell.calls[2]!.kind).toBe("writeFile");
  });
});
