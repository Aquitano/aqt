import { configHome, type HostEnv, MachineId, ProviderId, stateHome } from "@aqt/turnstash-core";
import { Effect, FileSystem, Path, Schema } from "effect";

export const AgentConfig = Schema.Struct({
  serverUrl: Schema.String,
  machineId: MachineId,
  machineName: Schema.String,
  token: Schema.String,
  disabledProviders: Schema.optionalKey(Schema.Array(ProviderId)),
});
export type AgentConfig = typeof AgentConfig.Type;

export interface AgentPaths {
  readonly configFile: string;
  readonly stateDb: string;
}

export const agentPaths = (host: HostEnv): AgentPaths => {
  const separator = host.os === "win32" ? "\\" : "/";
  const configDir =
    host.env["TURNSTASH_CONFIG_DIR"] ?? `${configHome(host)}${separator}aqt-turnstash`;
  const stateDir = host.env["TURNSTASH_STATE_DIR"] ?? `${stateHome(host)}${separator}aqt-turnstash`;
  return {
    configFile: `${configDir}${separator}config.json`,
    stateDb: `${stateDir}${separator}agent.db`,
  };
};

export class NotEnrolled extends Schema.TaggedError<NotEnrolled>()("NotEnrolled", {
  configFile: Schema.String,
}) {}

export class ConnectionConflict extends Schema.TaggedError<ConnectionConflict>()(
  "ConnectionConflict",
  {
    message: Schema.String,
  },
) {}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentConfig));

export const readConfig = Effect.fn("AgentConfig.read")(function* (configFile: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(configFile))) return yield* new NotEnrolled({ configFile });
  return yield* decodeConfig(yield* fs.readFileString(configFile));
});

export const checkConnection = Effect.fn("AgentConfig.checkConnection")(function* (
  paths: AgentPaths,
  identity?: Pick<AgentConfig, "serverUrl" | "machineId">,
) {
  const fs = yield* FileSystem.FileSystem;
  // A connect names its server and machine explicitly, so it may replace a config that no longer
  // parses (for example one truncated by a crash). Enrolment has no such identity to check.
  const saved = yield* readConfig(paths.configFile).pipe(
    Effect.map((config) => ({ kind: "found", config }) as const),
    Effect.catchTag("NotEnrolled", () => Effect.succeed({ kind: "missing" } as const)),
    Effect.catchTag("SchemaError", (error) =>
      identity === undefined ? Effect.fail(error) : Effect.succeed({ kind: "unreadable" } as const),
    ),
  );
  if (saved.kind === "unreadable") return null;
  const existing = saved.kind === "found" ? saved.config : null;
  let reason: string | null = null;
  if (existing === null) {
    if (yield* fs.exists(paths.stateDb))
      reason = "Agent state exists without its connection config.";
  } else if (identity === undefined) {
    reason = "This agent is already enrolled.";
  } else if (
    existing.serverUrl !== identity.serverUrl ||
    existing.machineId !== identity.machineId
  ) {
    reason = "The saved connection belongs to another server or machine.";
  }
  if (reason !== null) {
    return yield* new ConnectionConflict({
      message: `${reason} Restore the original config, or set both TURNSTASH_CONFIG_DIR and TURNSTASH_STATE_DIR to separate directories for a new connection.`,
    });
  }
  return existing;
});

export const writeConfig = Effect.fn("AgentConfig.write")(function* (
  configFile: string,
  config: AgentConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* ensureParentDirectory(configFile);
  const pending = `${configFile}.${crypto.randomUUID()}.tmp`;
  yield* fs.writeFileString(pending, JSON.stringify(config, null, 2), { mode: 0o600 });
  yield* fs.chmod(pending, 0o600);
  yield* fs.rename(pending, configFile);
});

export const ensureParentDirectory = Effect.fn("AgentConfig.ensureParentDirectory")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(file);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
});
