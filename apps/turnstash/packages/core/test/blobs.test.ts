import { expect, test } from "bun:test";

import { extractInlineBlobs, omitInlineBlobs } from "../src/blobs.ts";
import { sha256Hex } from "../src/hash.ts";

test("inline base64 images give way to their size while signatures and plain records stay as they were", () => {
  const image = "iVBOR".padEnd(2000, "A");
  const signature = "EqQB".padEnd(2000, "x");
  const text = { mimeType: "text/plain", data: "plain words ".repeat(200) };
  const payload = JSON.stringify({
    message: {
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
        { type: "thinking", thinking: "plan", signature },
      ],
    },
    toolUseResult: { file: { base64: image, type: "image/png" } },
    output: [{ image_url: `data:image/jpeg;base64,${image}` }],
    result: { content: [{ type: "image", data: image, mimeType: "image/png" }, text] },
  });
  expect(omitInlineBlobs(payload)).toBe(
    JSON.stringify({
      message: {
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: { omitted: "base64", bytes: 1500 },
            },
          },
          { type: "thinking", thinking: "plan", signature },
        ],
      },
      toolUseResult: { file: { base64: { omitted: "base64", bytes: 1500 }, type: "image/png" } },
      output: [{ image_url: { omitted: "base64", bytes: 1500, mediaType: "image/jpeg" } }],
      result: {
        content: [
          { type: "image", data: { omitted: "base64", bytes: 1500 }, mimeType: "image/png" },
          text,
        ],
      },
    }),
  );
  const plain = '{ "type": "user",  "text": "spacing kept" }';
  expect(omitInlineBlobs(plain)).toBe(plain);
});

test("extracting names each inline file by its sha256 in the marker and returns it once", () => {
  const image = "iVBOR".padEnd(2000, "A");
  const data = Buffer.from(image, "base64");
  const marker = { omitted: "base64", bytes: 1500, sha256: sha256Hex(data) };
  const extracted = extractInlineBlobs(
    JSON.stringify({
      message: { content: [{ type: "image", source: { type: "base64", data: image } }] },
      toolUseResult: { file: { base64: image, type: "image/png" } },
    }),
  );
  expect(JSON.parse(extracted.payload)).toEqual({
    message: { content: [{ type: "image", source: { type: "base64", data: marker } }] },
    toolUseResult: { file: { base64: marker, type: "image/png" } },
  });
  expect([...extracted.blobs]).toEqual([[marker.sha256, data]]);
});

test("data URI extraction preserves escaped bytes and leaves malformed encodings intact", () => {
  const data = Buffer.alloc(1100, 251);
  const uri = `data:image/png;base64,${encodeURIComponent(data.toString("base64"))}`;
  const extracted = extractInlineBlobs(JSON.stringify({ image: uri }));
  expect([...extracted.blobs]).toEqual([[sha256Hex(data), data]]);
  expect(JSON.parse(extracted.payload)).toEqual({
    image: {
      omitted: "base64",
      bytes: data.length,
      mediaType: "image/png",
      sha256: sha256Hex(data),
    },
  });
  for (const suffix of ["%XX", "!", "A"]) {
    const payload = JSON.stringify({ image: `data:image/png;base64,${"A".repeat(1100)}${suffix}` });
    expect(extractInlineBlobs(payload).payload).toBe(payload);
    expect(extractInlineBlobs(payload).blobs.size).toBe(0);
  }
});

test("small attachments are archived while oversized-line omission keeps its threshold", () => {
  const data = Buffer.from([0, 255, 1, 254]);
  const payload = JSON.stringify({ mime: "image/png", data: data.toString("base64") });
  expect([...extractInlineBlobs(payload).blobs]).toEqual([[sha256Hex(data), data]]);
  expect(omitInlineBlobs(payload)).toBe(payload);
});
