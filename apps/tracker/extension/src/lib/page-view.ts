import type { NavigationType } from "./events.ts";
import type { Rule } from "./rules.ts";

export function isNewPageView(
  prev: string,
  next: string,
  rule: Pick<Rule, "query_keys"> | undefined,
): boolean {
  const a = URL.parse(prev);
  const b = URL.parse(next);
  if (!a || !b) return prev !== next;
  if (a.origin !== b.origin || a.pathname !== b.pathname) return true;
  return (rule?.query_keys ?? []).some(
    (key) => a.searchParams.get(key) !== b.searchParams.get(key),
  );
}

export function navigationTypeFor(
  transitionType: string,
  qualifiers: readonly string[],
): NavigationType {
  if (qualifiers.includes("forward_back")) return "back_forward";
  if (transitionType === "reload") return "reload";
  return "load";
}

export function spaNavigationType(qualifiers: readonly string[]): "spa" | "back_forward" {
  return qualifiers.includes("forward_back") ? "back_forward" : "spa";
}
