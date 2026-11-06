import { MessageView, providerIds, type ProviderId } from "@aqt/turnstash-api";
import { Option, Schema } from "effect";

import type { BurnMode, FutureUsage } from "./limits-model";
import { isPeriodId, type PeriodId } from "./period";

export const roles = MessageView.fields.role.literals;

const UrlSearch = Schema.Record(Schema.String, Schema.Json);
export const decodeUrlSearch = Schema.decodeUnknownSync(UrlSearch);
const decodeScalar = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);
const stringValue = (value: Schema.Json | undefined): string | undefined =>
  Option.match(decodeScalar(value), { onNone: () => undefined, onSome: String });

export interface SearchState {
  readonly q?: string | undefined;
  readonly period?: PeriodId | undefined;
  readonly provider?: ProviderId | undefined;
  readonly projectKey?: string | undefined;
  readonly role?: MessageView["role"] | undefined;
}

export const parseSearchState = (search: typeof UrlSearch.Type): SearchState => {
  const q = stringValue(search.q)?.trim();
  const period = stringValue(search.period);
  const provider = providerIds.find((value) => value === stringValue(search.provider));
  const projectKey = stringValue(search.projectKey);
  const role = roles.find((value) => value === search.role);
  return {
    ...(q === undefined ? {} : { q }),
    ...(period === undefined || !isPeriodId(period) ? {} : { period }),
    ...(provider === undefined ? {} : { provider }),
    ...(projectKey === undefined ? {} : { projectKey }),
    ...(role === undefined ? {} : { role }),
  };
};

export interface ConversationListSearch {
  readonly q?: string | undefined;
  readonly projectKey?: string | undefined;
}

export const parseConversationListSearch = (
  search: typeof UrlSearch.Type,
): ConversationListSearch => {
  const q = stringValue(search.q)?.trim();
  const projectKey = stringValue(search.projectKey);
  return {
    ...(q === undefined || q === "" || q.length > 1024 || q.includes("\u0000") ? {} : { q }),
    ...(projectKey === undefined ||
    projectKey === "" ||
    projectKey.length > 4096 ||
    projectKey.includes("\u0000")
      ? {}
      : { projectKey }),
  };
};

export interface ConversationSearch {
  readonly message?: string;
  readonly q?: string;
  readonly invalidMessage?: true;
}

export const parseConversationSearch = (search: typeof UrlSearch.Type): ConversationSearch => {
  const message = stringValue(search.message);
  const q = stringValue(search.q);
  const invalidMessage =
    search.message !== undefined &&
    (message === undefined ||
      message.length === 0 ||
      message.length > 4096 ||
      message.includes("\u0000"));
  return {
    ...(invalidMessage
      ? { invalidMessage: true as const }
      : message === undefined
        ? {}
        : { message }),
    ...(q === undefined || q.length > 1024 ? {} : { q }),
  };
};

export const highlightSegments = (text: string, query: string) => {
  const terms = [
    ...new Set(
      Array.from(query.matchAll(/"([^"]+)"|(\S+)/g), (match) => match[1] ?? match[2] ?? "").filter(
        (term) => term !== "" && term !== "OR" && !term.startsWith("-"),
      ),
    ),
  ].sort((left, right) => right.length - left.length);
  if (terms.length === 0) return [{ text, matched: false }];
  const matcher = new RegExp(
    terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
  const segments: Array<{ readonly text: string; readonly matched: boolean }> = [];
  let start = 0;
  for (const match of text.matchAll(matcher)) {
    if (match.index > start)
      segments.push({ text: text.slice(start, match.index), matched: false });
    segments.push({ text: match[0], matched: true });
    start = match.index + match[0].length;
  }
  if (start < text.length) segments.push({ text: text.slice(start), matched: false });
  return segments;
};

export interface LimitsSearch {
  readonly windows?: Partial<Readonly<Record<ProviderId, number>>> | undefined;
  readonly selectionProvider?: ProviderId | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly provider?: ProviderId | undefined;
  readonly week?: number | undefined;
  readonly view?: "remaining" | "drain" | undefined;
  readonly burn?: BurnMode | undefined;
  readonly future?: FutureUsage | undefined;
}

const decodeWindows = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Number));

export const parseLimitsSearch = (search: typeof UrlSearch.Type): LimitsSearch => {
  const week = Number(stringValue(search.week));
  const rawWindows = Option.getOrUndefined(decodeWindows(search.windows));
  const windows = Object.fromEntries(
    providerIds.flatMap((provider) => {
      const minutes = rawWindows?.[provider];
      return minutes !== undefined && Number.isInteger(minutes) && minutes > 0 && minutes <= 525_600
        ? [[provider, minutes] as const]
        : [];
    }),
  );
  const from = Number(stringValue(search.from));
  const to = Number(stringValue(search.to));
  const selectionProvider = providerIds.find((value) => value === search.selectionProvider);
  const validSelection =
    selectionProvider !== undefined &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    to > from &&
    to <= 8_640_000_000_000_000;
  return {
    provider: providerIds.find((value) => value === search.provider),
    ...(Object.keys(windows).length > 0 ? { windows } : {}),
    ...(validSelection ? { selectionProvider, from, to } : {}),
    week: Number.isInteger(week) && week <= 0 && week >= -5200 ? week : undefined,
    view: search.view === "drain" ? "drain" : undefined,
    burn: (["window", "6h", "3h", "1h"] as const).find((value) => value === search.burn),
    future: (["same", "half", "double", "none"] as const).find((value) => value === search.future),
  };
};
