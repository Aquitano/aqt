import { Predicate, Schema } from "effect";

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
const base64Text = /^[\w+/-]+={0,2}$/;
const mediaTypeKeys = ["mediaType", "mimeType", "media_type", "mime_type"];

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

const isBlob = (object: Schema.JsonObject, key: string, value: Schema.Json): value is string =>
  isBlobField(object, key) &&
  Predicate.isString(value) &&
  value.length > minBlobChars &&
  base64Text.test(value);

// Returns the value itself when nothing inside it changed.
const withoutBlobs = (value: Schema.Json, marker: MarkerOf): Schema.Json => {
  if (Predicate.isString(value)) {
    const match = value.length > minBlobChars ? dataUri.exec(value) : null;
    return match === null ? value : marker(value.slice(match[0].length), match[1]);
  }
  if (isJsonArray(value)) {
    const items = value.map((item) => withoutBlobs(item, marker));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isJsonObject(value)) return value;
  const entries = Object.entries(value).map(([key, item]): [string, Schema.Json] =>
    isBlob(value, key, item) ? [key, marker(item, undefined)] : [key, withoutBlobs(item, marker)],
  );
  return entries.some(([key, item]) => item !== value[key]) ? Object.fromEntries(entries) : value;
};

const replaceBlobs = (payload: string, marker: MarkerOf): string => {
  if (payload.length <= minBlobChars) return payload;
  const parsed = parseJson(payload);
  if (parsed === undefined) return payload;
  const stripped = withoutBlobs(parsed, marker);
  return stripped === parsed ? payload : JSON.stringify(stripped);
};

export const omitInlineBlobs = (payload: string): string => replaceBlobs(payload, markerOf);

// The payload with each blob's marker naming its file by sha256, and the files it held, once each.
export const extractInlineBlobs = (payload: string) => {
  const blobs = new Map<string, Buffer>();
  const stripped = replaceBlobs(payload, (base64, mediaType) => {
    const data = Buffer.from(base64, "base64");
    const sha256 = sha256Hex(data);
    blobs.set(sha256, data);
    return { ...markerOf(base64, mediaType), sha256 };
  });
  return { payload: stripped, blobs };
};

// The stored file an image part can show, once its data has been moved out of the record.
export const storedBlobOf = (data: Schema.Json | undefined) =>
  isOmittedBlob(data) && data.sha256 !== undefined ? { sha256: data.sha256 } : {};
