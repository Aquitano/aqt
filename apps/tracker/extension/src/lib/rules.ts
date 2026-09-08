import { type } from "arktype";

const DEFAULT_DWELL_MS = 5000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export const Rule = type({
  extractor: "string",
  version: "number",
  hosts: "string[]",
  path_regex: "string",
  query_keys: "string[]",
  dwell_ms: "number",
  recapture: "string",
  max_bytes: "number",
});
export type Rule = typeof Rule.infer;

// Go encodes nil slices as null and unset ints as 0; the wire form is normalised once, here.
const WireRule = type({
  extractor: "string",
  version: "number",
  hosts: "string[] | null",
  path_regex: "string",
  query_keys: "string[] | null",
  dwell_ms: "number",
  recapture: "string",
  max_bytes: "number",
});

export const RulesResponse = type({ rules: WireRule.array() }).pipe(({ rules }) =>
  rules.map((rule): Rule => ({
    ...rule,
    hosts: rule.hosts ?? [],
    query_keys: rule.query_keys ?? [],
    dwell_ms: rule.dwell_ms > 0 ? rule.dwell_ms : DEFAULT_DWELL_MS,
    max_bytes: rule.max_bytes > 0 ? rule.max_bytes : DEFAULT_MAX_BYTES,
  })),
);

export function hostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase();
  const wanted = pattern.toLowerCase();
  if (wanted.startsWith("*.")) return host.endsWith(wanted.slice(1));
  return host === wanted;
}

function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern === "") return true;
  try {
    return new RegExp(pattern).test(pathname);
  } catch {
    return false;
  }
}

export function matchRule(rules: readonly Rule[], url: URL): Rule | undefined {
  return rules.find(
    (rule) =>
      rule.hosts.some((host) => hostMatches(host, url.hostname)) &&
      pathMatches(rule.path_regex, url.pathname),
  );
}
