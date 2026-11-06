import { quotaStateOf } from "@aqt/turnstash-analysis";
import { providerLabels } from "@aqt/turnstash-api";
import type { CurrentLimitsReport, ProviderId } from "@aqt/turnstash-api";

import { weekdayTime } from "../format";
import { windowLabel } from "../limits-model";

export interface QuotaAlertPreferences {
  readonly low: boolean;
  readonly unused: boolean;
  readonly desktop: boolean;
}

export interface QuotaAlert {
  readonly id: string;
  readonly kind: "low" | "unused";
  readonly provider: ProviderId;
  readonly windowMinutes: number;
  readonly resetsAtMs: number;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly title: string;
  readonly description: string;
}

const recent = (iso: string, nowMs: number, maxAge: number) => {
  const age = nowMs - Date.parse(iso);
  return age >= -60_000 && age <= maxAge;
};

export const quotaAlertsOf = (
  report: CurrentLimitsReport,
  preferences: QuotaAlertPreferences,
  nowMs: number,
): ReadonlyArray<QuotaAlert> => {
  if (!recent(report.generatedAt, nowMs, 10 * 60_000)) return [];
  return report.providers.flatMap(({ provider, windows }) => {
    const blocked = windows.some(
      (open) => open.usedPercent >= 100 && Date.parse(open.resetsAt) > nowMs,
    );
    return windows.flatMap((open): Array<QuotaAlert> => {
      const resetsAtMs = Date.parse(open.resetsAt);
      const state = quotaStateOf(
        {
          startsAtMs: Date.parse(open.startsAt),
          resetsAtMs,
          endedAtMs: Date.parse(open.endedAt),
          outcome: open.outcome,
          firstObservedAtMs: Date.parse(open.firstObservedAt),
          lastObservedAtMs: Date.parse(open.lastObservedAt),
          firstUsedPercent: open.firstUsedPercent,
          usedPercent: open.usedPercent,
          points: open.points.map((point) => ({
            atMs: Date.parse(point.at),
            usedPercent: point.usedPercent,
          })),
        },
        nowMs,
        blocked,
      );
      const remaining = state.remainingPercent;
      const kind =
        preferences.low && state.low ? "low" : preferences.unused && state.unused ? "unused" : null;
      if (kind === null) return [];
      const label = `${providerLabels[provider]} ${windowLabel(open.windowMinutes).toLowerCase()} quota`;
      return [
        {
          id: `${provider}:${open.windowMinutes}:${open.firstObservedAt}:${kind}`,
          kind,
          provider,
          windowMinutes: open.windowMinutes,
          resetsAtMs,
          firstObservedAtMs: Date.parse(open.firstObservedAt),
          lastObservedAtMs: Date.parse(open.lastObservedAt),
          title: `${label} ${kind === "unused" ? "expires soon" : remaining <= 0 ? "is exhausted" : "is running low"}`,
          description:
            kind === "unused"
              ? `About ${Math.round(state.remainingAtReset)}% may expire unused at ${weekdayTime(resetsAtMs)}, at the last hour's pace.`
              : `${remaining > 0 && remaining < 1 ? "<1" : Math.round(remaining)}% left. ${state.runningOut && remaining > 10 ? "At the last hour's pace, it may run out within an hour. " : ""}Resets ${weekdayTime(resetsAtMs)}.`,
        },
      ];
    });
  });
};
