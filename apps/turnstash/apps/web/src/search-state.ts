import { MessageView, providerIds, type ProviderId } from "@aqt/turnstash-api";
import { Option, Schema } from "effect";

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
