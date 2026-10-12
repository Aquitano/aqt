import { isJsonObject } from "@aqt/turnstash-core";
import { Predicate, type Schema } from "effect";

// Postgres rejects U+0000 inside jsonb and text, and transcripts do contain it (binary tool output).
export const scrubText = (text: string): string => text.replaceAll("\u0000", "\ufffd");

export const scrubOptional = (text: string | undefined): string | null =>
  text === undefined ? null : scrubText(text);

const scrub = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (isJsonObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [scrubText(key), scrub(item)]),
    );
  return value;
};

// SAFETY: scrub only rewrites string contents and keeps every key, index and nesting, so the
// input type still describes the output.
export const scrubJson = <A extends Schema.Json>(value: A): A => scrub(value) as A;
