import type { Rule } from "./rules.ts";

export const RECAPTURE_MIN_INTERVAL_MS = 5 * 60_000;

type QuietPage = {
  rule: Pick<Rule, "recapture"> | undefined;
  lastCapturedAt: string | undefined;
  now: number;
};

export type RecaptureDecision =
  | { kind: "now" }
  | { kind: "defer"; due: number }
  | { kind: "never" };

const never: RecaptureDecision = { kind: "never" };

export function recaptureDecision({ rule, lastCapturedAt, now }: QuietPage): RecaptureDecision {
  if (rule?.recapture !== "after_quiet" || lastCapturedAt === undefined) return never;
  const last = Date.parse(lastCapturedAt);
  if (Number.isNaN(last)) return never;
  const due = last + RECAPTURE_MIN_INTERVAL_MS;
  return now >= due ? { kind: "now" } : { kind: "defer", due };
}
