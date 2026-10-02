import type { SearchHit, Visits } from "./api.ts";

const UNITS = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });

function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Chrome parses an omnibox description as XML, so a bare & or < in a title
// would break the suggestion.
export function suggestionDescription(hit: Pick<SearchHit, "title" | "canonical_url">): string {
  const url = `<url>${escapeMarkup(hit.canonical_url)}</url>`;
  return hit.title ? `${escapeMarkup(hit.title)} - ${url}` : url;
}

export function searchPagePath(query: string): string {
  return `search.html?${new URLSearchParams({ q: query })}`;
}

function ago(seconds: number): string {
  const unit = UNITS.find(([, size]) => seconds >= size);
  return unit ? relative.format(-Math.floor(seconds / unit[1]), unit[0]) : "just now";
}

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under 1 min";
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

export function describeVisits(verb: string, visits: Visits, now: number): string | undefined {
  if (visits.count === 0 || visits.last_at === null) return undefined;
  const since = ago((now - Date.parse(visits.last_at)) / 1000);
  const when = visits.count === 1 ? `once, ${since}` : `${visits.count} times, last ${since}`;
  return `${verb} ${when}, ${duration(visits.active_seconds)} in total`;
}
