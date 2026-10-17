import { Predicate, Schema } from "effect";

import { isJsonArray, isJsonObject, parseJson } from "./json.ts";

// Stands in for an inline base64 image or document that was not kept.
export const OmittedBlob = Schema.Struct({
  omitted: Schema.Literal("base64"),
  bytes: Schema.Natural,
  mediaType: Schema.optionalKey(Schema.String),
});
export type OmittedBlob = typeof OmittedBlob.Type;
export const isOmittedBlob = Schema.is(OmittedBlob);

const minBlobChars = 1024;
const dataUri = /^data:([^;,]*);base64,/;
const base64Text = /^[\w+/-]+={0,2}$/;
const mediaTypeKeys = ["mediaType", "mimeType", "media_type", "mime_type"];

const decodedBytes = (base64: string): number =>
  Math.floor((base64.replace(/=+$/, "").length * 3) / 4);

const omit = (base64: string, mediaType: string | undefined): OmittedBlob => ({
  omitted: "base64",
  bytes: decodedBytes(base64),
  ...(mediaType === undefined || mediaType === "" ? {} : { mediaType }),
});

// Claude image and document sources ({type: "base64", data}), Claude Read results ({base64}), MCP and Pi
// images ({data, mimeType}) and data: URIs. Thinking signatures are base64 too and are kept, so a blob is
// recognised by where it sits, and only base64 text there is replaced.
const isBlobField = (object: Schema.JsonObject, key: string): boolean =>
  key === "base64" ||
  (key === "data" &&
    (object["type"] === "base64" ||
      mediaTypeKeys.some((name) => Predicate.isString(object[name]))));

const isBlob = (object: Schema.JsonObject, key: string, value: Schema.Json): value is string =>
  isBlobField(object, key) &&
  Predicate.isString(value) &&
  value.length > minBlobChars &&
  base64Text.test(value);

// Returns the value itself when nothing inside it changed.
const withoutBlobs = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) {
    const match = value.length > minBlobChars ? dataUri.exec(value) : null;
    return match === null ? value : omit(value.slice(match[0].length), match[1]);
  }
  if (isJsonArray(value)) {
    const items = value.map(withoutBlobs);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isJsonObject(value)) return value;
  const entries = Object.entries(value).map(([key, item]): [string, Schema.Json] =>
    isBlob(value, key, item) ? [key, omit(item, undefined)] : [key, withoutBlobs(item)],
  );
  return entries.some(([key, item]) => item !== value[key]) ? Object.fromEntries(entries) : value;
};

export const omitInlineBlobs = (payload: string): string => {
  if (payload.length <= minBlobChars) return payload;
  const parsed = parseJson(payload);
  if (parsed === undefined) return payload;
  const stripped = withoutBlobs(parsed);
  return stripped === parsed ? payload : JSON.stringify(stripped);
};
