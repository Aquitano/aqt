import { describe, expect, test } from "bun:test";

import { withTranscript } from "./transcript.ts";

describe("withTranscript", () => {
  test("appends the transcript inside body where no caption can close its script", () => {
    const html = withTranscript("<html><body><p>page</p></body></html>", {
      video_id: "v",
      language: "en",
      kind: "manual",
      segments: [{ start: 1.5, text: "</script><b>caption</b>" }],
    });
    expect(html).toBe(
      String.raw`<html><body><p>page</p><script type="application/json" id="tracker-transcript">{"video_id":"v","language":"en","kind":"manual","segments":[{"start":1.5,"text":"</script><b>caption</b>"}]}</script></body></html>`,
    );
  });
});
