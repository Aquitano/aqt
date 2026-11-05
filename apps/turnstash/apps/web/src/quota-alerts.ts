import { providerLabels } from "@aqt/turnstash-api";
import type { LimitsReport, ProviderId } from "@aqt/turnstash-api";

import { weekdayTime } from "./format";
import { burnPerHour, hourMs, openWindowOf, projectLimit, windowLabel } from "./limits-model";

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
  readonly title: string;
  readonly description: string;
}

const recent = (iso: string, nowMs: number, maxAge: number) => {
  const age = nowMs - Date.parse(iso);
  return age >= -60_000 && age <= maxAge;
};

export const quotaAlertsOf = (
  report: LimitsReport,
  preferences: QuotaAlertPreferences,
  nowMs: number,
): ReadonlyArray<QuotaAlert> => {
  if (!recent(report.generatedAt, nowMs, 10 * 60_000)) return [];
  return report.providers.flatMap(({ provider, series }) => {
    const windows = series.flatMap((item) => {
      const open = openWindowOf(item);
      return open === null ? [] : [open];
    });
    const blocked = windows.some(
      (open) => open.usedPercent >= 100 && Date.parse(open.resetsAt) > nowMs,
    );
    return windows.flatMap((open): Array<QuotaAlert> => {
      const resetsAtMs = Date.parse(open.resetsAt);
      if (resetsAtMs <= nowMs || !recent(open.lastObservedAt, nowMs, 30 * 60_000)) return [];
      const remaining = 100 - open.usedPercent;
      const canProject =
        open.points.length > 0 &&
        Date.parse(open.lastObservedAt) - Date.parse(open.firstObservedAt) > hourMs / 4;
      const projection = projectLimit({
        open,
        windowMinutes: open.windowMinutes,
        nowMs,
        burn: burnPerHour(open, "1h", nowMs),
        untilMs: resetsAtMs,
      });
      const runningOut =
        canProject && projection.emptyAtMs !== null && projection.emptyAtMs <= nowMs + hourMs;
      const kind =
        preferences.low && (remaining <= 10 || runningOut)
          ? "low"
          : preferences.unused &&
              !blocked &&
              canProject &&
              resetsAtMs <= nowMs + hourMs &&
              projection.remainingAtReset !== null &&
              projection.remainingAtReset >= 20
            ? "unused"
            : null;
      if (kind === null) return [];
      const label = `${providerLabels[provider]} ${windowLabel(open.windowMinutes).toLowerCase()} quota`;
      return [
        {
          id: `${provider}:${open.windowMinutes}:${open.firstObservedAt}:${kind}`,
          kind,
          provider,
          windowMinutes: open.windowMinutes,
          resetsAtMs,
          title: `${label} ${kind === "unused" ? "expires soon" : remaining <= 0 ? "is exhausted" : "is running low"}`,
          description:
            kind === "unused"
              ? `About ${Math.round(projection.remainingAtReset ?? 0)}% may expire unused at ${weekdayTime(resetsAtMs)}, at the last hour's pace.`
              : `${remaining > 0 && remaining < 1 ? "<1" : Math.round(remaining)}% left. ${runningOut && remaining > 10 ? "At the last hour's pace, it may run out within an hour. " : ""}Resets ${weekdayTime(resetsAtMs)}.`,
        },
      ];
    });
  });
};
