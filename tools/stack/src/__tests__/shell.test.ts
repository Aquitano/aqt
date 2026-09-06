import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunShellRunner } from "../shell.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("BunShellRunner", () => {
  test("reserves new directories without accepting an existing destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "aqt-stack-"));
    directories.push(root);
    const shell = new BunShellRunner();
    const destination = join(root, "app");
    expect(await shell.exists(destination)).toBe(false);
    await shell.reserveDirectory(destination);
    expect(await shell.exists(destination)).toBe(true);
    await expect(shell.reserveDirectory(destination)).rejects.toThrow();
    await shell.writeFile(join(destination, "package.json"), '{"name":"@aqt/example"}');
    expect(await shell.readPackageJson(join(destination, "package.json"))).toEqual({
      name: "@aqt/example",
    });
  });
});
