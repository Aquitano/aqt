import { limitResetToleranceMs } from "@aqt/turnstash-core";

export interface LimitObservation {
  readonly observedAtMs: number;
  readonly usedPercent: number;
  readonly resetsAtMs: number;
}

export interface LimitWindowPoint {
  readonly atMs: number;
  readonly usedPercent: number;
}

export type LimitWindowOutcome = "open" | "reset" | "replaced";

export interface BuiltLimitWindow {
  readonly startsAtMs: number;
  readonly resetsAtMs: number;
  readonly endedAtMs: number;
  readonly outcome: LimitWindowOutcome;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly firstUsedPercent: number;
  readonly usedPercent: number;
  readonly points: ReadonlyArray<LimitWindowPoint>;
}

interface Draft {
  readonly order: number;
  resetsAtMs: number;
  lastObservedAtMs: number;
  readonly points: Array<LimitWindowPoint>;
}

// A window's usage only rises, and concurrent sessions report older values late, so a reading counts only when it
// raises the window's high mark. One taken after its own reset is a replay of old history.
export const limitWindowsOf = (
  windowMinutes: number,
  observations: ReadonlyArray<LimitObservation>,
  nowMs: number,
): ReadonlyArray<BuiltLimitWindow> => {
  const drafts: Array<Draft> = [];
  const byReset = new Map<number, Set<Draft>>();
  const indexReset = (draft: Draft) => {
    const key = Math.floor(draft.resetsAtMs / limitResetToleranceMs);
    const bucket = byReset.get(key) ?? new Set<Draft>();
    bucket.add(draft);
    byReset.set(key, bucket);
  };
  const ordered = observations.toSorted((a, b) => a.observedAtMs - b.observedAtMs);
  for (const { observedAtMs, usedPercent, resetsAtMs } of ordered) {
    if (observedAtMs > resetsAtMs + limitResetToleranceMs) continue;
    const key = Math.floor(resetsAtMs / limitResetToleranceMs);
    let draft: Draft | undefined;
    for (let neighbor = key - 1; neighbor <= key + 1; neighbor += 1) {
      const bucket = byReset.get(neighbor);
      if (bucket === undefined) continue;
      for (const candidate of bucket)
        if (
          (draft === undefined || candidate.order < draft.order) &&
          Math.abs(candidate.resetsAtMs - resetsAtMs) < limitResetToleranceMs
        )
          draft = candidate;
    }
    if (draft === undefined) {
      const created = {
        order: drafts.length,
        resetsAtMs,
        lastObservedAtMs: observedAtMs,
        points: [{ atMs: observedAtMs, usedPercent }],
      };
      drafts.push(created);
      indexReset(created);
      continue;
    }
    const previousKey = Math.floor(draft.resetsAtMs / limitResetToleranceMs);
    draft.resetsAtMs = resetsAtMs;
    if (previousKey !== key) {
      const previous = byReset.get(previousKey);
      previous?.delete(draft);
      if (previous?.size === 0) byReset.delete(previousKey);
      indexReset(draft);
    }
    draft.lastObservedAtMs = observedAtMs;
    const high = draft.points.at(-1)?.usedPercent ?? 0;
    if (usedPercent > high) draft.points.push({ atMs: observedAtMs, usedPercent });
  }
  const windowMs = windowMinutes * 60_000;
  const chronological = drafts.toSorted((a, b) => a.resetsAtMs - b.resetsAtMs);
  return chronological.flatMap((draft, index) => {
    const [first] = draft.points;
    const last = draft.points.at(-1);
    if (first === undefined || last === undefined) return [];
    const next = chronological[index + 1];
    const nextStartsAtMs = next === undefined ? undefined : next.resetsAtMs - windowMs;
    const replaced =
      nextStartsAtMs !== undefined && nextStartsAtMs < draft.resetsAtMs - limitResetToleranceMs;
    return [
      {
        startsAtMs: draft.resetsAtMs - windowMs,
        resetsAtMs: draft.resetsAtMs,
        endedAtMs: replaced ? Math.max(nextStartsAtMs, last.atMs) : draft.resetsAtMs,
        outcome: replaced ? "replaced" : draft.resetsAtMs > nowMs ? "open" : "reset",
        firstObservedAtMs: first.atMs,
        lastObservedAtMs: Math.max(draft.lastObservedAtMs, last.atMs),
        firstUsedPercent: first.usedPercent,
        usedPercent: last.usedPercent,
        points: draft.points,
      },
    ];
  });
};

export interface ObservedLimitHit {
  readonly atMs: number;
  readonly windowMinutes: number | null;
  readonly message: string;
}

export interface CollapsedLimitHit extends ObservedLimitHit {
  readonly count: number;
}

const hitClusterGapMs = 30 * 60_000;

// Agents retry against a limit they already hit, so one event leaves many records close together.
export const collapseLimitHits = (
  hits: ReadonlyArray<ObservedLimitHit>,
): ReadonlyArray<CollapsedLimitHit> => {
  const collapsed: Array<CollapsedLimitHit & { lastAtMs: number }> = [];
  for (const hit of hits.toSorted((a, b) => a.atMs - b.atMs)) {
    const latest = collapsed.at(-1);
    if (
      latest !== undefined &&
      latest.windowMinutes === hit.windowMinutes &&
      hit.atMs - latest.lastAtMs < hitClusterGapMs
    ) {
      collapsed[collapsed.length - 1] = {
        ...latest,
        count: latest.count + 1,
        lastAtMs: hit.atMs,
      };
    } else {
      collapsed.push({ ...hit, count: 1, lastAtMs: hit.atMs });
    }
  }
  return collapsed.map(({ lastAtMs: _lastAtMs, ...hit }) => hit);
};
