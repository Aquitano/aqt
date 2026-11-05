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
  readonly observations: Array<LimitObservation>;
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
  for (const observation of ordered) {
    const { observedAtMs, resetsAtMs } = observation;
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
        observations: [observation],
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
    draft.observations.push(observation);
  }
  const windowMs = windowMinutes * 60_000;
  const chronological = drafts.toSorted((a, b) => a.resetsAtMs - b.resetsAtMs);
  return chronological.flatMap((draft, index) => {
    const next = chronological[index + 1];
    const nextStartsAtMs = next === undefined ? undefined : next.resetsAtMs - windowMs;
    const replaced =
      nextStartsAtMs !== undefined && nextStartsAtMs < draft.resetsAtMs - limitResetToleranceMs;
    const endedAtMs = replaced ? nextStartsAtMs : draft.resetsAtMs;
    const observations = replaced
      ? draft.observations.filter((observation) => observation.observedAtMs < endedAtMs)
      : draft.observations;
    const [first] = observations;
    const last = observations.at(-1);
    if (first === undefined || last === undefined) return [];
    let usedPercent = first.usedPercent;
    const points = [{ atMs: first.observedAtMs, usedPercent }];
    for (const observation of observations) {
      if (observation.usedPercent <= usedPercent) continue;
      usedPercent = observation.usedPercent;
      points.push({ atMs: observation.observedAtMs, usedPercent });
    }
    return [
      {
        startsAtMs: draft.resetsAtMs - windowMs,
        resetsAtMs: draft.resetsAtMs,
        endedAtMs,
        outcome: replaced ? "replaced" : draft.resetsAtMs > nowMs ? "open" : "reset",
        firstObservedAtMs: first.observedAtMs,
        lastObservedAtMs: last.observedAtMs,
        firstUsedPercent: first.usedPercent,
        usedPercent,
        points,
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
