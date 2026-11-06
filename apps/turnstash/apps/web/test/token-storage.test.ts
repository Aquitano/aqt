import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { readToken, writeToken } from "../src/api";

let stored = new Map<string, string>();
let readsFail = false;
let writesFail = false;

beforeEach(() => {
  stored = new Map();
  readsFail = false;
  writesFail = false;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (readsFail) throw new Error("Storage blocked");
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (writesFail) throw new Error("Storage full");
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      if (writesFail) throw new Error("Storage blocked");
      stored.delete(key);
    },
  });
  writeToken("");
});

afterEach(() => vi.unstubAllGlobals());

test("persisted tokens follow updates and removal from another tab", () => {
  expect(readToken()).toBe("");
  writeToken("saved-token");
  expect(stored.get("cb_token")).toBe("saved-token");
  stored.set("cb_token", "other-tab-token");
  expect(readToken()).toBe("other-tab-token");
  stored.delete("cb_token");
  expect(readToken()).toBe("");
});

test("failed storage writes retain replacement and cleared tokens for this page", () => {
  writeToken("old-token");
  writesFail = true;
  writeToken("replacement-token");
  expect(readToken()).toBe("replacement-token");
  expect(stored.get("cb_token")).toBe("old-token");
  writeToken("");
  expect(readToken()).toBe("");
  readsFail = true;
  writeToken("memory-token");
  expect(readToken()).toBe("memory-token");
  writeToken("");
  expect(readToken()).toBe("");
  readsFail = false;
  writesFail = false;
  writeToken("persisted-again");
  stored.set("cb_token", "new-other-tab-token");
  expect(readToken()).toBe("new-other-tab-token");
});
