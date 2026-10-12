#!/usr/bin/env bun
import { hostname } from "node:os";
import { styleText } from "node:util";

import {
  hostEnvFromProcess,
  MachineId,
  providerIds,
  providerLabels,
  type SourceProvider,
  type SourceRoot,
} from "@aqt/turnstash-core";
import { normalizers, sourceProviders } from "@aqt/turnstash-providers";
import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Clock,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Result,
  Runtime,
  Schema,
} from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";

import pkg from "../package.json" with { type: "json" };
import { archiveCommands } from "./archive.ts";
import { collect, type CollectSummary } from "./collect.ts";
import {
  agentPaths,
  type AgentConfig,
  checkConnection,
  readConfig,
  writeConfig,
} from "./config.ts";
import { type CommitSyncSummary, syncCommits } from "./git.ts";
import { Providers, providersLayer } from "./providers.ts";
import { apiClientFor, push, type PushSummary } from "./push.ts";
import { currentTarget, installSchedule, uninstallSchedule } from "./schedule.ts";
import { AgentState, type RejectionReason } from "./state.ts";
import {
  ago,
  bold,
  count,
  dim,
  formatBytes,
  formatNumber,
  formatTime,
  mark,
  print,
  section,
  step,
  type Summary,
  table,
  tildify,
  withSpinner,
} from "./ui.ts";

const version = pkg.version;
const host = hostEnvFromProcess();
const paths = agentPaths(host);
const home = (path: string) => tildify(path, host.home);

const withState = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(AgentState.layer(paths.stateDb)));

const errorText = (error: Error & { readonly _tag: string }) => {
  const message = error.message === "" ? error._tag : error.message;
  return error.cause instanceof Error ? `${message}: ${error.cause.message}` : message;
};

const notEnrolledHint = `${mark.warn} Not enrolled. Run: turnstash enroll --server <url> --admin-token <token>`;
const retryHint = "retry them with turnstash sync --retry-refused";

const rejectionLabels: Record<RejectionReason, string> = {
  "batch-limit": "larger than a batch",
  refused: "refused by the server",
  "read-limit": "too large to read",
};

const describeCollect = (summary: CollectSummary, dryRun: boolean): Summary => {
  const scanned = providerIds.flatMap((provider) => {
    const counts = summary.byProvider[provider];
    return counts === undefined ? [] : [{ provider, ...counts }];
  });
  const sources = scanned.reduce((total, { streams }) => total + streams, 0);
  const found =
    summary.records === 0 ? "No new records" : `Found ${count(summary.records, "new record")}`;
  return [
    `${found} in ${count(sources, "source")}${dryRun ? dim(" (dry run, nothing saved)") : ""}`,
    ...table(
      scanned
        .filter(({ records }) => records > 0)
        .map(({ provider, records }) => [providerLabels[provider], formatNumber(records)]),
      ["left", "right"],
    ),
    ...summary.errors.map(
      (error) =>
        `${mark.warn} ${providerLabels[error.provider]} ${home(error.path)}: ${error.error}`,
    ),
  ];
};

const describePush = (summary: PushSummary): Summary => {
  const sent = summary.accepted + summary.duplicates + summary.replaced;
  const details = [
    summary.replaced > 0 ? `${formatNumber(summary.replaced)} updated` : null,
    summary.duplicates > 0 ? `${formatNumber(summary.duplicates)} already stored` : null,
  ].filter((detail) => detail !== null);
  return [
    sent === 0
      ? "Nothing new to push"
      : `Pushed ${count(sent, "record")} in ${count(summary.batches, "batch", "batches")}${details.length > 0 ? dim(` (${details.join(", ")})`) : ""}`,
    summary.requeued > 0
      ? dim(`Re-sent ${count(summary.requeued, "record")} an earlier agent version set aside`)
      : null,
    summary.tombstones > 0
      ? dim(`Skipping ${count(summary.tombstones, "conversation")} deleted on the server`)
      : null,
    summary.refused > 0
      ? `${mark.warn} The server refused ${count(summary.refused, "record")}: see turnstash doctor, or ${retryHint}`
      : null,
  ];
};

const describeLinked = ({ commits, repositories }: CommitSyncSummary) => {
  if (repositories === 0) return "No git repositories to link";
  const across = `across ${count(repositories, "repository", "repositories")}`;
  return commits === 0
    ? `No new commits ${across}`
    : `Linked ${count(commits, "new or changed commit")} ${across}`;
};

const describeCommits = (summary: CommitSyncSummary): Summary => [
  describeLinked(summary),
  ...summary.errors.map((error) => `${mark.warn} git ${home(error.path)}: ${error.error}`),
];

const describeConfigWritten = (headline: string) =>
  print([
    `${mark.done} ${headline}`,
    dim(`  Config written to ${home(paths.configFile)}`),
    dim("  Next: turnstash sync"),
  ]);

const parseEvery = (value: string): Option.Option<number> => {
  const match = /^(\d+)\s*(m|min|h)?$/.exec(value.trim());
  if (!match) return Option.none();
  const amount = Number(match[1]);
  return amount > 0 ? Option.some(match[2] === "h" ? amount * 60 : amount) : Option.none();
};

const enroll = Command.make(
  "enroll",
  {
    server: Flag.String("server").pipe(
      Flag.withDescription("Server URL, e.g. https://turnstash.example.com"),
    ),
    adminToken: Flag.Redacted("admin-token").pipe(
      Flag.withDescription("ADMIN_TOKEN configured on the server"),
    ),
    name: Flag.String("name").pipe(
      Flag.optional,
      Flag.withDescription("Machine name shown in the UI (default: hostname)"),
    ),
  },
  Effect.fn("cli.enroll")(function* (flags) {
    yield* checkConnection(paths);
    const client = yield* apiClientFor(flags.server, flags.adminToken, { retry: false });
    const machineName = Option.getOrElse(flags.name, () => hostname());
    const response = yield* withSpinner(`Enrolling ${machineName} with ${flags.server}`, () =>
      client.admin.enroll({
        payload: { name: machineName, os: host.os, arch: process.arch, agentVersion: version },
      }),
    );
    yield* writeConfig(paths.configFile, {
      serverUrl: flags.server,
      machineId: response.machineId,
      machineName,
      token: response.token,
    });
    yield* describeConfigWritten(`Enrolled ${machineName} ${dim(response.machineId)}`);
  }),
).pipe(Command.withDescription("Register this machine with the server and store its token"));

const connect = Command.make(
  "connect",
  {
    server: Flag.String("server").pipe(Flag.withDescription("Server URL")),
    machineId: Flag.String("machine-id").pipe(Flag.withSchema(MachineId)),
    token: Flag.Redacted("token").pipe(
      Flag.withDescription("Machine token created in Settings > Machines"),
    ),
  },
  Effect.fn("cli.connect")(function* (flags) {
    const existing = yield* checkConnection(paths, {
      serverUrl: flags.server,
      machineId: flags.machineId,
    });
    yield* writeConfig(paths.configFile, {
      ...existing,
      serverUrl: flags.server,
      machineId: flags.machineId,
      machineName: existing?.machineName ?? hostname(),
      token: Redacted.value(flags.token),
    });
    yield* describeConfigWritten(`Connected to machine ${flags.machineId}`);
  }),
).pipe(Command.withDescription("Store credentials for a machine already enrolled in the web UI"));

const sync = Command.make(
  "sync",
  {
    provider: Flag.Literals("provider", providerIds).pipe(
      Flag.optional,
      Flag.withDescription("Only scan one provider"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Scan and report without writing state or pushing"),
    ),
    retryRefused: Flag.Boolean("retry-refused").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Send records the server refused earlier once more"),
    ),
  },
  Effect.fn("cli.sync")(function* (flags) {
    const config = yield* readConfig(paths.configFile);
    yield* withState(
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        const disabled = config.disabledProviders ?? [];
        const providers = Option.match(flags.provider, {
          onNone: () => providerIds.filter((provider) => !disabled.includes(provider)),
          onSome: (provider) => [provider],
        });
        if (flags.retryRefused && !flags.dryRun) {
          const requeued = yield* state.retryRefused();
          yield* print([`${mark.done} Re-queued ${count(requeued, "refused record")}`]);
        }
        yield* step(
          "Scanning transcripts",
          (report) =>
            collect({
              host,
              providers,
              dryRun: flags.dryRun,
              onProgress: ({ provider, scanned, total }) =>
                report(
                  `Scanning ${providerLabels[provider]}`,
                  total === 0 ? undefined : { done: scanned, total },
                ),
            }),
          (summary) => describeCollect(summary, flags.dryRun),
        );
        if (flags.dryRun) return;
        const client = yield* apiClientFor(config.serverUrl, Redacted.make(config.token));
        yield* step(
          "Pushing records",
          (report) =>
            push(
              client,
              { machineId: config.machineId, agentVersion: version },
              { onProgress: ({ sent, total }) => report("Pushing records", { done: sent, total }) },
            ),
          describePush,
        );
        yield* state.setMeta("last_sync_at", DateTime.formatIso(yield* DateTime.now));
        yield* step(
          "Linking commits",
          () => syncCommits(client, config.machineId),
          describeCommits,
        );
      }),
    );
  }),
).pipe(Command.withDescription("Collect new transcript records and push them to the server"));

const status = Command.make(
  "status",
  {},
  Effect.fn("cli.status")(function* () {
    const { machineName, machineId, serverUrl } = yield* readConfig(paths.configFile);
    yield* withState(
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        const pending = yield* state.pendingCount();
        const pendingBytes = yield* state.pendingBytes();
        const rejected = yield* state.rejectedRecords();
        const lastSync = yield* state.getMeta("last_sync_at");
        const now = yield* Clock.currentTimeMillis;
        yield* print([
          ...table([
            [dim("Machine"), `${machineName}  ${dim(machineId)}`],
            [dim("Server"), serverUrl],
            [
              dim("Last sync"),
              lastSync === null
                ? styleText("yellow", "never")
                : `${ago(lastSync, now)}  ${dim(formatTime(lastSync))}`,
            ],
            [
              dim("Outbox"),
              pending === 0
                ? "empty"
                : styleText(
                    "yellow",
                    `${count(pending, "record")} (${formatBytes(pendingBytes)}) waiting to be pushed`,
                  ),
            ],
          ]),
          rejected.length > 0
            ? `${mark.warn} ${count(rejected.length, "record")} will not be sent: see turnstash doctor`
            : null,
          rejected.some((rejection) => rejection.reason === "refused")
            ? dim(`  Refused by the server: ${retryHint}`)
            : null,
        ]);
      }),
    );
  }),
).pipe(Command.withDescription("Show enrolment, outbox and last sync"));

const checkRoot = Effect.fn("cli.doctor.checkRoot")(function* (
  source: SourceProvider,
  root: SourceRoot,
) {
  const fs = yield* FileSystem.FileSystem;
  const row = (status: string, detail: string, muted = false) => [
    `${status} ${muted ? dim(root.label) : root.label}`,
    muted ? dim(detail) : detail,
    dim(home(root.path)),
  ];
  if (!(yield* fs.exists(root.path).pipe(Effect.orElseSucceed(() => false))))
    return row(mark.idle, "not found", true);
  const discovered = yield* source.discover(root).pipe(Effect.result);
  if (Result.isFailure(discovered))
    return row(mark.fail, styleText("red", discovered.failure._tag));
  const found = discovered.success.length;
  return row(found > 0 ? mark.done : mark.idle, count(found, "source"), found === 0);
});

const outboxHealth = Effect.gen(function* () {
  const state = yield* AgentState.Service;
  const pending = yield* state.pendingCount();
  const rejected = yield* state.rejectedRecords();
  return [
    pending === 0
      ? `${mark.done} Nothing waiting to be pushed`
      : `${mark.idle} ${count(pending, "record")} waiting for the next sync`,
    ...rejected.map(
      (rejection) =>
        `${mark.warn} ${rejectionLabels[rejection.reason]}: ${providerLabels[rejection.provider]} ${rejection.streamId} #${rejection.recordKey} ${dim(`(${formatBytes(rejection.bytes)})`)}`,
    ),
    rejected.some((rejection) => rejection.reason === "refused")
      ? dim(`  Refused records: ${retryHint}`)
      : null,
  ];
});

const serverHealth = ({ serverUrl, token }: AgentConfig) =>
  Effect.gen(function* () {
    const client = yield* apiClientFor(serverUrl, Redacted.make(token), { retry: false });
    return yield* withSpinner(`Checking ${serverUrl}`, () => client.system.health()).pipe(
      Effect.match({
        onSuccess: (health) =>
          `${mark.done} ${serverUrl}  ${dim(`version ${health.version} · ${count(health.dirtyConversations, "conversation")} queued`)}`,
        onFailure: (error) => `${mark.fail} ${serverUrl}  ${styleText("red", errorText(error))}`,
      }),
    );
  });

const doctor = Command.make(
  "doctor",
  {},
  Effect.fn("cli.doctor")(function* () {
    const { sources } = yield* Providers;
    const roots = yield* withSpinner("Looking for transcripts", () =>
      Effect.forEach(sources, (source) =>
        Effect.forEach(source.roots(host), (root, index) =>
          checkRoot(source, root).pipe(
            Effect.map((row) => [index === 0 ? providerLabels[source.id] : "", ...row]),
          ),
        ),
      ),
    );
    const config = yield* readConfig(paths.configFile).pipe(
      Effect.map(Option.some),
      Effect.catchTag("NotEnrolled", () => Effect.succeedNone),
    );
    const enrolled = Option.isSome(config)
      ? [
          ...section("Outbox", yield* withState(outboxHealth)),
          ...section("Server", [yield* serverHealth(config.value)]),
        ]
      : ["", notEnrolledHint];
    yield* print([
      `${bold(`turnstash ${version}`)} ${dim(`${host.os}/${process.arch}`)}`,
      ...table([
        [dim("Config"), home(paths.configFile)],
        [dim("State"), home(paths.stateDb)],
      ]),
      ...section("Transcripts", table(roots.flat(), ["left", "left", "right"])),
      ...enrolled,
    ]);
  }),
).pipe(Command.withDescription("Check provider roots, outbox and server connectivity"));

const every = Flag.String("every").pipe(
  Flag.withDefault("15m"),
  Flag.filterMap(parseEvery, () => "minutes such as 15m or hours such as 1h"),
  Flag.withDescription("Interval, e.g. 15m or 1h"),
);

const scheduleInstall = Command.make(
  "install",
  { every },
  Effect.fn("cli.schedule.install")(function* (flags) {
    const installed = yield* installSchedule(host, currentTarget(), flags.every);
    yield* print([
      `${mark.done} Syncing every ${count(flags.every, "minute")}  ${dim(home(installed))}`,
    ]);
  }),
).pipe(
  Command.withDescription(
    "Install a launchd, systemd or Task Scheduler job that runs turnstash sync",
  ),
);

const scheduleUninstall = Command.make(
  "uninstall",
  {},
  Effect.fn("cli.schedule.uninstall")(function* () {
    yield* uninstallSchedule(host);
    yield* print([`${mark.done} Removed the scheduled sync`]);
  }),
).pipe(Command.withDescription("Remove the scheduled sync job"));

const schedule = Command.make("schedule").pipe(
  Command.withDescription("Manage the periodic sync job"),
  Command.withSubcommands([scheduleInstall, scheduleUninstall]),
);

const cli = Command.make("turnstash").pipe(
  Command.withDescription(
    "Collects AI coding-agent transcripts and usage on this machine, syncs them to your aqt-turnstash server and reads the archive back",
  ),
  Command.withSubcommands([enroll, connect, sync, status, doctor, schedule, ...archiveCommands]),
);

// Failures are printed as one line below; this fails the process without the runtime printing
// the error again as a log with a stack trace.
class Reported extends Schema.TaggedError<Reported>()("Reported", {}) {
  override readonly [Runtime.errorReported] = false;
}

const describeFailure = (error: Error & { readonly _tag: string }) =>
  `${mark.fail} ${errorText(error)}  ${dim(error._tag)}`;

const main = Command.run(cli, { version }).pipe(
  Effect.catchTag("NotEnrolled", () => Console.error(notEnrolledHint)),
  Effect.catchIf(
    (error) => !CliError.isCliError(error),
    (error) =>
      Console.error(describeFailure(error)).pipe(Effect.andThen(Effect.fail(new Reported()))),
  ),
  Effect.provide(
    Layer.mergeAll(
      BunServices.layer,
      BunHttpClient.layer,
      providersLayer(sourceProviders, normalizers),
    ),
  ),
);

// A reader that stops early, as in `turnstash sessions export <id> | head`, closes stdout. The rest of
// the output has nowhere to go, but the command still finishes its work instead of crashing.
process.stdout.on("error", (error) => {
  if (!("code" in error && error.code === "EPIPE")) throw error;
});

BunRuntime.runMain(main);
