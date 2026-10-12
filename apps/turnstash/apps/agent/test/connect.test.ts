import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { runCli, withDirectory } from "./support.ts";

const machineId = "d4aa4082-eaf3-4de6-acb0-23985c26d539";
const server = "https://turnstash.invalid";
const connectArgs = [
  "connect",
  "--server",
  server,
  "--machine-id",
  machineId,
  "--token",
  "fixture-machine-token",
];

test("connect stores UI-created machine credentials without enrolling another machine", () =>
  withDirectory(async (directory) => {
    const configDirectory = join(directory, "config");
    const { exitCode, stdout, stderr } = await runCli(directory, connectArgs);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).not.toContain("fixture-machine-token");
    const configFile = join(configDirectory, "config.json");
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      serverUrl: "https://turnstash.invalid",
      machineId,
      machineName: hostname(),
      token: "fixture-machine-token",
    });
    if (process.platform !== "win32") {
      expect((await stat(configFile)).mode & 0o777).toBe(0o600);
      expect((await stat(configDirectory)).mode & 0o777).toBe(0o700);
    }
  }));

test("connect refreshes the same identity without losing saved settings or state", () =>
  withDirectory(async (directory) => {
    await runCli(directory, connectArgs);
    const configFile = join(directory, "config", "config.json");
    const config = {
      ...JSON.parse(await readFile(configFile, "utf8")),
      machineName: "saved name",
      disabledProviders: ["codex"],
    };
    await writeFile(configFile, JSON.stringify(config));
    await mkdir(join(directory, "state"));
    const stateFile = join(directory, "state", "agent.db");
    await writeFile(stateFile, "existing state");

    const result = await runCli(directory, [...connectArgs.slice(0, -1), "refreshed-token"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
      ...config,
      token: "refreshed-token",
    });
    expect(await readFile(stateFile, "utf8")).toBe("existing state");
  }));

test("connect and enroll reject replacing an existing connection before sending requests", () =>
  withDirectory(async (directory) => {
    await runCli(directory, connectArgs);
    const configFile = join(directory, "config", "config.json");
    const original = await readFile(configFile, "utf8");
    for (const args of [
      connectArgs.map((value) => (value === server ? "https://other.invalid" : value)),
      connectArgs.map((value) =>
        value === machineId ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : value,
      ),
      ["enroll", "--server", server, "--admin-token", "fixture-admin-token"],
    ]) {
      const result = await runCli(directory, args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("ConnectionConflict");
      expect(await readFile(configFile, "utf8")).toBe(original);
    }
  }));

test("a missing config cannot attach existing state to a new connection", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "state"));
    const stateFile = join(directory, "state", "agent.db");
    await writeFile(stateFile, "orphan state");
    for (const args of [
      connectArgs,
      ["enroll", "--server", server, "--admin-token", "fixture-admin-token"],
    ]) {
      const result = await runCli(directory, args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("ConnectionConflict");
      expect(await readFile(stateFile, "utf8")).toBe("orphan state");
    }
  }));

test("connect replaces a config that no longer parses, enroll does not", () =>
  withDirectory(async (directory) => {
    await runCli(directory, connectArgs);
    const configFile = join(directory, "config", "config.json");
    await writeFile(configFile, '{"serverUrl":"https://turn');
    const enroll = await runCli(directory, [
      "enroll",
      "--server",
      server,
      "--admin-token",
      "fixture-admin-token",
    ]);
    expect(enroll.exitCode).not.toBe(0);
    expect((await runCli(directory, connectArgs)).exitCode).toBe(0);
    expect(JSON.parse(await readFile(configFile, "utf8")).machineId).toBe(machineId);
  }));

test("status and doctor fail on a config that no longer parses", () =>
  withDirectory(async (directory) => {
    await runCli(directory, connectArgs);
    await writeFile(join(directory, "config", "config.json"), '{"serverUrl":"https://turn');
    for (const command of ["status", "doctor"]) {
      const result = await runCli(directory, [command]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SchemaError");
    }
  }));

test("diagnostics and sync before enrollment leave the agent ready to connect", () =>
  withDirectory(async (directory) => {
    for (const command of ["status", "doctor", "sync"]) {
      const result = await runCli(directory, [command]);
      expect(result.exitCode).toBe(0);
    }
    expect((await runCli(directory, connectArgs)).exitCode).toBe(0);
  }));
