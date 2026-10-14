import { configHome, type HostEnv } from "@aqt/turnstash-core";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { agentPaths, ensureParentDirectory } from "./config.ts";

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Int,
  message: Schema.String,
}) {}

const launchdLabel = "me.aquitano.turnstash";
const systemdUnit = "turnstash";
const windowsTask = "aqt-turnstash";

const run = Effect.fn("Schedule.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make(command, args));
  const [stderr, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
    { concurrency: 2 },
  );
  if (exitCode !== 0 && options.allowFailure !== true) {
    const commandLine = [command, ...args].join(" ");
    const detail = stderr.trim();
    return yield* new CommandFailed({
      command: commandLine,
      exitCode,
      message: `${commandLine} exited ${exitCode}${detail === "" ? "" : `: ${detail}`}`,
    });
  }
}, Effect.scoped);

const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export interface ScheduleTarget {
  readonly executable: string;
  readonly script: string;
}

export const currentTarget = (): ScheduleTarget => ({
  executable: process.execPath,
  script: process.argv[1] ?? "",
});

const scheduleEnvironmentKeys = [
  "PATH",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "TURNSTASH_CONFIG_DIR",
  "TURNSTASH_STATE_DIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CONFIG_DIRS",
  "TURNSTASH_DESKTOP_SESSIONS_DIR",
  "CODEX_HOME",
  "OPENCODE_DATA_DIR",
  "OPENCODE_DB_PREFIX",
  "TURNSTASH_CURSOR_DB",
  "TURNSTASH_COPILOT_SESSION_STATE_DIR",
  "TURNSTASH_COPILOT_SESSION_STORE_DB",
  "TURNSTASH_COPILOT_GLOBAL_STORAGE_DIR",
  "TURNSTASH_COPILOT_WORKSPACE_STORAGE_DIR",
  "GEMINI_SESSIONS_DIR",
  "GEMINI_DIR",
  "PI_SESSIONS_DIR",
  "OMP_SESSIONS_DIR",
  "ANTIGRAVITY_DATA_DIR",
] as const;

const scheduleRunnerPath = (host: HostEnv) => `${agentPaths(host).configFile}.schedule.js`;

export const writeScheduleRunner = Effect.fn("Schedule.writeRunner")(function* (
  host: HostEnv,
  target: ScheduleTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  const environment = Object.fromEntries(
    scheduleEnvironmentKeys.flatMap((key) =>
      host.env[key] === undefined ? [] : [[key, host.env[key]]],
    ),
  );
  const script = scheduleRunnerPath(host);
  const source = `const result = Bun.spawnSync(${JSON.stringify([target.executable, target.script, "sync"])}, {
  env: { ...process.env, ...${JSON.stringify({ ...environment, HOME: host.home })} },
  stdin: "ignore", stdout: "inherit", stderr: "inherit",
})
process.exit(result.exitCode)
`;
  yield* ensureParentDirectory(script);
  yield* fs.writeFileString(script, source, { mode: 0o600 });
  yield* fs.chmod(script, 0o600);
  return { executable: target.executable, script };
});

const plist = (
  target: ScheduleTarget,
  everySeconds: number,
) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(target.executable)}</string>
    <string>${escapeXml(target.script)}</string>
  </array>
  <key>StartInterval</key><integer>${everySeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/${launchdLabel}.log</string>
  <key>StandardErrorPath</key><string>/tmp/${launchdLabel}.log</string>
</dict>
</plist>
`;

const systemdArgument = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

const systemdService = (target: ScheduleTarget) => `[Unit]
Description=aqt-turnstash sync

[Service]
Type=oneshot
ExecStart=${systemdArgument(target.executable)} ${systemdArgument(target.script)}
`;

const systemdTimer = (everyMinutes: number) => `[Unit]
Description=aqt-turnstash sync every ${everyMinutes} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${everyMinutes}min
Persistent=true

[Install]
WantedBy=timers.target
`;

const launchdPlistPath = (host: HostEnv) =>
  `${host.home}/Library/LaunchAgents/${launchdLabel}.plist`;
const systemdDir = (host: HostEnv) => `${configHome(host)}/systemd/user`;
const launchdDomain = () => `gui/${process.getuid?.() ?? 501}`;

export const installSchedule = Effect.fn("Schedule.install")(function* (
  host: HostEnv,
  target: ScheduleTarget,
  everyMinutes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* writeScheduleRunner(host, target);
  switch (host.os) {
    case "darwin": {
      const file = launchdPlistPath(host);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, plist(runner, everyMinutes * 60));
      yield* run("launchctl", ["bootout", launchdDomain(), file], { allowFailure: true });
      yield* run("launchctl", ["bootstrap", launchdDomain(), file]);
      return file;
    }
    case "linux": {
      const directory = systemdDir(host);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(`${directory}/${systemdUnit}.service`, systemdService(runner));
      yield* fs.writeFileString(`${directory}/${systemdUnit}.timer`, systemdTimer(everyMinutes));
      yield* run("systemctl", ["--user", "daemon-reload"]);
      yield* run("systemctl", ["--user", "enable", "--now", `${systemdUnit}.timer`]);
      return `${directory}/${systemdUnit}.timer`;
    }
    case "win32": {
      const command = `"${runner.executable}" "${runner.script}"`;
      yield* run("schtasks", [
        "/Create",
        "/F",
        "/SC",
        "MINUTE",
        "/MO",
        String(everyMinutes),
        "/TN",
        windowsTask,
        "/TR",
        command,
      ]);
      return windowsTask;
    }
  }
});

export const uninstallSchedule = Effect.fn("Schedule.uninstall")(function* (host: HostEnv) {
  const fs = yield* FileSystem.FileSystem;
  switch (host.os) {
    case "darwin": {
      const file = launchdPlistPath(host);
      yield* run("launchctl", ["bootout", launchdDomain(), file], { allowFailure: true });
      yield* fs.remove(file, { force: true });
      yield* fs.remove(scheduleRunnerPath(host), { force: true });
      return;
    }
    case "linux": {
      const directory = systemdDir(host);
      yield* run("systemctl", ["--user", "disable", "--now", `${systemdUnit}.timer`], {
        allowFailure: true,
      });
      yield* fs.remove(`${directory}/${systemdUnit}.timer`, { force: true });
      yield* fs.remove(`${directory}/${systemdUnit}.service`, { force: true });
      yield* run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
      yield* fs.remove(scheduleRunnerPath(host), { force: true });
      return;
    }
    case "win32": {
      yield* run("schtasks", ["/Delete", "/F", "/TN", windowsTask], { allowFailure: true });
      yield* fs.remove(scheduleRunnerPath(host), { force: true });
      return;
    }
  }
});
