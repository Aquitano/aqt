import { describe, expect, test } from "bun:test";

import { mediaKey } from "./paths";

describe("mediaKey", () => {
  test("re-bases an absolute path from another machine onto its key", () => {
    expect(
      mediaKey("C:\\Users\\me\\Code\\aqt-gallery\\apps\\server\\uploads\\thumbs\\u1\\a.webp"),
    ).toBe("thumbs/u1/a.webp");
    expect(mediaKey("/home/me/aqt/apps/server/uploads/originals/u1/a.png")).toBe(
      "originals/u1/a.png",
    );
  });

  test("leaves an already-relative key untouched", () => {
    expect(mediaKey("originals/u1/a.png")).toBe("originals/u1/a.png");
  });

  test("leaves a path without a media directory untouched", () => {
    expect(mediaKey("/tmp/elsewhere/a.png")).toBe("/tmp/elsewhere/a.png");
  });
});
