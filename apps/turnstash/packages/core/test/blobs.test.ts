import { expect, test } from "bun:test";

import { omitInlineBlobs } from "../src/blobs.ts";

test("inline base64 images give way to their size while signatures and plain records stay as they were", () => {
  const image = "iVBOR".padEnd(2000, "A");
  const signature = "EqQB".padEnd(2000, "x");
  const payload = JSON.stringify({
    message: {
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
        { type: "thinking", thinking: "plan", signature },
      ],
    },
    toolUseResult: { file: { base64: image, type: "image/png" } },
    output: [{ image_url: `data:image/jpeg;base64,${image}` }],
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
    }),
  );
  const plain = '{ "type": "user",  "text": "spacing kept" }';
  expect(omitInlineBlobs(plain)).toBe(plain);
});
