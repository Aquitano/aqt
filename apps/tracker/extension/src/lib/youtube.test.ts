import { describe, expect, test } from "bun:test";

import { preferredTrack, track } from "./youtube.ts";

describe("track", () => {
  test("reads the video, language and kind out of transcript params", () => {
    expect(
      track(
        "CgtpRzlDRTU1d2J0WRIOQ2dBU0FtVnVHZ0ElM0QYASozZW5nYWdlbWVudC1wYW5lbC1zZWFyY2hhYmxlLXRyYW5zY3JpcHQtc2VhcmNoLXBhbmVsMAA4AUAB",
      ),
    ).toEqual({ videoId: "iG9CE55wbtY", language: "en", kind: "manual" });
    expect(
      track(
        "Cgt3WDc4aUtoSW5zYxISQ2dOaGMzSVNBbVZ1R2dBJTNEGAEqM2VuZ2FnZW1lbnQtcGFuZWwtc2VhcmNoYWJsZS10cmFuc2NyaXB0LXNlYXJjaC1wYW5lbDAAOAFAAA%3D%3D",
      ),
    ).toEqual({ videoId: "wX78iKhInsc", language: "en", kind: "asr" });
    expect(track("not base64 %")).toEqual({ videoId: "", language: "", kind: "manual" });
  });
});

describe("preferredTrack", () => {
  const de = { videoId: "v", language: "de", kind: "manual" } as const;
  const en = { videoId: "v", language: "en", kind: "manual" } as const;
  const auto = { videoId: "v", language: "fr", kind: "asr" } as const;

  test("prefers a manual track in the page language, then English, then the auto-generated one", () => {
    expect(preferredTrack([auto, en, de], "de-DE")).toBe(de);
    expect(preferredTrack([auto, de, en], "ja")).toBe(en);
    expect(preferredTrack([de, auto], "ja")).toBe(auto);
    expect(preferredTrack([de], "ja")).toBeUndefined();
  });
});
