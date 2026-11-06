import {
  type HostEnv,
  isoTimestampOf,
  type LimitReading,
  type MachineId,
} from "@aqt/turnstash-core";
import { claudeStateFiles } from "@aqt/turnstash-providers";
import { Effect, FileSystem, Option, Schema } from "effect";

import type { ApiClient } from "./push.ts";

const UsageWindow = Schema.Struct({
  utilization: Schema.Finite,
  resets_at: Schema.NullOr(Schema.String),
});

// Claude Code refreshes this cache itself, so the agent needs neither its OAuth token nor the network to read it.
// Decoding names only the fields sent on, so nothing else in the file can leave the machine.
const ClaudeState = Schema.fromJsonString(
  Schema.Struct({
    cachedUsageUtilization: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          fetchedAtMs: Schema.Finite,
          utilization: Schema.Struct({
            five_hour: Schema.optional(Schema.NullOr(UsageWindow)),
            seven_day: Schema.optional(Schema.NullOr(UsageWindow)),
          }),
        }),
      ),
    ),
    oauthAccount: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          organizationRateLimitTier: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);

const decodeClaudeState = Schema.decodeUnknownOption(ClaudeState);

const windowsOfClaude = [
  { key: "five_hour", windowMinutes: 300 },
  { key: "seven_day", windowMinutes: 10_080 },
] as const;

export const claudeLimitReadings = (text: string): ReadonlyArray<LimitReading> =>
  Option.match(decodeClaudeState(text), {
    onNone: () => [],
    onSome: ({ cachedUsageUtilization: cache, oauthAccount }) => {
      const observedAt = isoTimestampOf(cache?.fetchedAtMs);
      if (cache === null || cache === undefined || observedAt === undefined) return [];
      const plan = oauthAccount?.organizationRateLimitTier;
      return windowsOfClaude.flatMap(({ key, windowMinutes }): ReadonlyArray<LimitReading> => {
        const window = cache.utilization[key];
        const resetsAt = isoTimestampOf(window?.resets_at ?? undefined);
        if (window === null || window === undefined || resetsAt === undefined) return [];
        return [
          {
            provider: "claude",
            windowMinutes,
            observedAt,
            usedPercent: Math.min(100, Math.max(0, window.utilization)),
            resetsAt,
            ...(plan === null || plan === undefined ? {} : { plan }),
          },
        ];
      });
    },
  });

export interface LimitSyncSummary {
  readonly readings: number;
  readonly accepted: number;
  readonly error: string | null;
}

// A missing file, a changed format or a server without this endpoint must not fail the transcript sync.
export const syncLimits = (client: ApiClient, machineId: MachineId, host: HostEnv) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const texts = yield* Effect.forEach(claudeStateFiles(host), (file) =>
      fs.readFileString(file).pipe(Effect.orElseSucceed(() => "")),
    );
    const readings = texts.flatMap(claudeLimitReadings);
    if (readings.length === 0) return { readings: 0, accepted: 0, error: null };
    const { accepted } = yield* client.ingest.pushLimits({ payload: { machineId, readings } });
    return { readings: readings.length, accepted, error: null };
  }).pipe(
    Effect.catch((error): Effect.Effect<LimitSyncSummary> =>
      Effect.succeed({ readings: 0, accepted: 0, error: error.message }),
    ),
    Effect.withSpan("Limits.sync"),
  );
