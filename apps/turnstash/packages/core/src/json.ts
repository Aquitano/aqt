import { Predicate, type Schema } from "effect";

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isJsonArray = (value: Schema.Json | undefined): value is Schema.JsonArray =>
  Array.isArray(value);

export const jsonObject = (value: Schema.Json | undefined): Schema.JsonObject | undefined =>
  isJsonObject(value) ? value : undefined;

export const jsonArray = (value: Schema.Json | undefined): Schema.JsonArray =>
  isJsonArray(value) ? value : [];

export const jsonString = (value: Schema.Json | undefined): string | undefined =>
  Predicate.isString(value) && value !== "" ? value : undefined;

export const jsonNumber = (value: Schema.Json | undefined): number | undefined =>
  Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;

export const jsonCount = (value: Schema.Json | undefined): number =>
  Predicate.isNumber(value) && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

const firstAt =
  <A>(read: (value: Schema.Json | undefined) => A | undefined) =>
  (source: Schema.Json | undefined, ...keys: ReadonlyArray<string>): A | undefined => {
    if (!isJsonObject(source)) return undefined;
    for (const key of keys) {
      const value = read(source[key]);
      if (value !== undefined) return value;
    }
    return undefined;
  };

export const jsonObjectAt = firstAt(jsonObject);
export const jsonStringAt = firstAt(jsonString);
export const jsonNumberAt = firstAt(jsonNumber);

const firstArrayAt = firstAt((value) => (isJsonArray(value) ? value : undefined));

export const jsonArrayAt = (
  source: Schema.Json | undefined,
  ...keys: ReadonlyArray<string>
): Schema.JsonArray => firstArrayAt(source, ...keys) ?? [];

// JSON.parse rather than Schema.Json, which rejects a whole document over one number past the double
// range. JSON.parse reads that number as ±Infinity, which jsonNumber and jsonCount skip.
export const parseJson = (text: string): Schema.Json | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const parseJsonObject = (text: string): Schema.JsonObject | undefined =>
  jsonObject(parseJson(text));
