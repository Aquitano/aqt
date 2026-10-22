import { Predicate, Result, Schema } from "effect";

import { sha256Hex } from "./hash.ts";
import { isJsonArray, isJsonObject, parseJson } from "./json.ts";
import { ContentHash } from "./records.ts";

// Stands in for an inline base64 image or document. The server stores the file under its sha256; a marker the
// agent writes for a line too large to send has none, because the file never left the machine.
export const OmittedBlob = Schema.Struct({
  omitted: Schema.Literal("base64"),
  bytes: Schema.Natural,
  mediaType: Schema.optionalKey(Schema.String),
  sha256: Schema.optionalKey(ContentHash),
});
export type OmittedBlob = typeof OmittedBlob.Type;
export const isOmittedBlob = Schema.is(OmittedBlob);

const minBlobChars = 1024;
const dataUri = /^data:([^;,]*);base64,/;
const base64Text = /^[A-Za-z0-9+/_-]+={0,2}$/;
const isBase64Text = (value: string): boolean =>
  base64Text.test(value) &&
  (value.length % 4 === 0 || (!value.endsWith("=") && value.length % 4 !== 1));
const mediaTypeKeys = ["mediaType", "mimeType", "media_type", "mime_type", "mime"];

const decodedBytes = (base64: string): number =>
  Math.floor((base64.replace(/=+$/, "").length * 3) / 4);

type MarkerOf = (base64: string, mediaType: string | undefined) => OmittedBlob;

const markerOf: MarkerOf = (base64, mediaType) => ({
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

const isBlob = (
  object: Schema.JsonObject,
  key: string,
  value: Schema.Json,
  minChars: number,
): value is string =>
  isBlobField(object, key) &&
  Predicate.isString(value) &&
  value.length > minChars &&
  isBase64Text(value);

// Returns the value itself when nothing inside it changed.
const withoutBlobs = (
  value: Schema.Json,
  marker: MarkerOf,
  minChars: number,
  sha256s?: Set<string>,
): Schema.Json => {
  if (Predicate.isString(value)) {
    const match = value.length > minChars ? dataUri.exec(value) : null;
    if (match === null) return value;
    const decoded = Result.try(() => decodeURIComponent(value.slice(match[0].length)));
    return Result.isFailure(decoded) ||
      decoded.success.length === 0 ||
      !isBase64Text(decoded.success)
      ? value
      : marker(decoded.success, match[1]);
  }
  if (isJsonArray(value)) {
    const items = value.map((item) => withoutBlobs(item, marker, minChars, sha256s));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isJsonObject(value)) return value;
  if (isOmittedBlob(value) && value.sha256 !== undefined) sha256s?.add(value.sha256);
  const entries = Object.entries(value).map(([key, item]): [string, Schema.Json] =>
    isBlob(value, key, item, minChars)
      ? [key, marker(item, undefined)]
      : [key, withoutBlobs(item, marker, minChars, sha256s)],
  );
  return entries.some(([key, item]) => item !== value[key]) ? Object.fromEntries(entries) : value;
};

const replaceBlobs = (
  payload: string,
  marker: MarkerOf,
  minChars: number,
  sha256s?: Set<string>,
): string => {
  if (payload.length <= minChars) return payload;
  const parsed = parseJson(payload);
  if (parsed === undefined) return payload;
  const stripped = withoutBlobs(parsed, marker, minChars, sha256s);
  return stripped === parsed ? payload : JSON.stringify(stripped);
};

export const omitInlineBlobs = (payload: string): string =>
  replaceBlobs(payload, markerOf, minBlobChars);

// The payload with each blob's marker naming its file by sha256, and the files it held, once each.
export const extractInlineBlobs = (payload: string) => {
  const blobs = new Map<string, Buffer>();
  const sha256s = new Set<string>();
  const stripped = replaceBlobs(
    payload,
    (base64, mediaType) => {
      const data = Buffer.from(base64, "base64");
      const sha256 = sha256Hex(data);
      blobs.set(sha256, data);
      sha256s.add(sha256);
      return { ...markerOf(base64, mediaType), sha256 };
    },
    0,
    sha256s,
  );
  return { payload: stripped, blobs, sha256s };
};

// The stored file an image part can show, once its data has been moved out of the record.
export const storedBlobOf = (data: Schema.Json | undefined) =>
  isOmittedBlob(data) && data.sha256 !== undefined ? { sha256: data.sha256 } : {};
