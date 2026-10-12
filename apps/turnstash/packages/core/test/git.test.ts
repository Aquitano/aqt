import { expect, test } from "bun:test";

import { normalizeRemoteUrl } from "../src/git.ts";

test("remote urls collapse to one identity and never carry credentials or local paths", () => {
  expect(normalizeRemoteUrl("git@github.com:Aquitano/aqt-turnstash.git")).toBe(
    "github.com/Aquitano/aqt-turnstash",
  );
  expect(
    normalizeRemoteUrl("https://x-access-token:ghp_secret@github.com/Aquitano/aqt-turnstash"),
  ).toBe("github.com/Aquitano/aqt-turnstash");
  expect(normalizeRemoteUrl("ssh://git@GitHub.com:22/aquitano//turnstash.GIT/")).toBe(
    "github.com/aquitano/turnstash",
  );
  expect(normalizeRemoteUrl("C:\\Users\\me\\repo")).toBeNull();
  expect(normalizeRemoteUrl("file:///home/me/repo")).toBeNull();
  expect(normalizeRemoteUrl("/home/me/repo")).toBeNull();
});
