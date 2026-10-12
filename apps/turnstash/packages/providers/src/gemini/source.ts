import type { HostEnv, SourceDescriptor, SourceProvider, SourceRoot } from "@aqt/turnstash-core";
import { Effect, FileSystem, Stream } from "effect";

import { walkFiles } from "../walk.ts";
import { firstJsonObject } from "./normalize.ts";

const sessionFile = /^[^/]+\/chats\/session-[^/]*\.jsonl?$/;

const headBytes = 64 * 1024;

const roots = (host: HostEnv): ReadonlyArray<SourceRoot> => {
  const separator = host.os === "win32" ? "\\" : "/";
  const sessionsDir = host.env["GEMINI_SESSIONS_DIR"];
  const geminiDir = host.env["GEMINI_DIR"];
  const candidates: ReadonlyArray<SourceRoot | undefined> = [
    sessionsDir === undefined || sessionsDir === ""
      ? undefined
      : { path: sessionsDir, label: "GEMINI_SESSIONS_DIR" },
    geminiDir === undefined || geminiDir === ""
      ? undefined
      : { path: `${geminiDir}${separator}tmp`, label: "GEMINI_DIR" },
    host.home === ""
      ? undefined
      : { path: `${host.home}${separator}.gemini${separator}tmp`, label: "tmp" },
  ];
  const seen = new Set<string>();
  const found: Array<SourceRoot> = [];
  for (const candidate of candidates) {
    if (candidate === undefined || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    found.push(candidate);
  }
  return found;
};

const readHead = Effect.fn("Gemini.readHead")(function* (absolutePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stream(absolutePath, { bytesToRead: headBytes }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
  );
});

const kindOf = (head: string): "json" | "jsonl" => {
  const first = firstJsonObject(head);
  if (first === undefined) return "json";
  return Array.isArray(first["messages"]) ? "json" : "jsonl";
};

const discover = Effect.fn("Gemini.discover")(function* (root: SourceRoot) {
  const files = yield* walkFiles(root, (relativePath) => sessionFile.test(relativePath), {
    maxDepth: 3,
  });
  const descriptors: Array<SourceDescriptor> = [];
  for (const file of files) {
    const head = yield* readHead(file.absolutePath);
    if (head.trim() === "") continue;
    descriptors.push(
      kindOf(head) === "json"
        ? { kind: "json", root, relativePath: file.relativePath }
        : { kind: "jsonl", root, relativePath: file.relativePath },
    );
  }
  return descriptors;
});

export const geminiSource: SourceProvider = { id: "gemini", roots, discover };
