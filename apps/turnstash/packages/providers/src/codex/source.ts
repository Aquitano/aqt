import {
  isJsonObject,
  parseJsonObject,
  type HostEnv,
  type SourceDescriptor,
  type SourceProvider,
  type SourceRoot,
} from "@aqt/turnstash-core";
import { Effect, FileSystem, Option, Stream } from "effect";

import { distinctRoots } from "../roots.ts";
import { walkFiles, type WalkedFile } from "../walk.ts";

const rolloutPath = /^(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/rollout-[^/]+\.jsonl$/;
const archivedPrefix = "archived_sessions/";

// session_meta embeds the full system prompt and runs to 21 KB, so the head read has to be
// generous or the first line comes back truncated mid-JSON.
const headBytes = 1024 * 1024;

const homeRoot = (host: HostEnv): string | undefined =>
  host.home.length === 0
    ? undefined
    : host.os === "win32"
      ? `${host.home}\\.codex`
      : `${host.home}/.codex`;

const roots = (host: HostEnv): ReadonlyArray<SourceRoot> => {
  const candidates = [
    { path: host.env["CODEX_HOME"], label: "CODEX_HOME" },
    { path: homeRoot(host), label: ".codex" },
  ];
  return distinctRoots(
    candidates.flatMap(({ path, label }) =>
      path === undefined || path.length === 0 ? [] : [{ path, label }],
    ),
  );
};

const isRollout = Effect.fn("Codex.isRollout")(function* (absolutePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const head = yield* fs.stream(absolutePath, { bytesToRead: headBytes }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runHead,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none<string>())),
  );
  if (Option.isNone(head)) return false;
  const line = parseJsonObject(head.value);
  return line !== undefined && line["type"] === "session_meta" && isJsonObject(line["payload"]);
});

const liveFirst = (files: ReadonlyArray<WalkedFile>): ReadonlyArray<WalkedFile> => {
  const byBasename = new Map<string, WalkedFile>();
  for (const file of files) {
    const basename = file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1);
    const kept = byBasename.get(basename);
    if (kept === undefined || kept.relativePath.startsWith(archivedPrefix))
      byBasename.set(basename, file);
  }
  return [...byBasename.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};

export const codexSource: SourceProvider = {
  id: "codex",
  roots,
  discover: Effect.fn("Codex.discover")(function* (root: SourceRoot) {
    // Elsewhere the Codex home holds logs, databases and, on Windows, sockets that stat rejects.
    const files = yield* walkFiles(root, (relativePath) => rolloutPath.test(relativePath), {
      within: ["sessions", "archived_sessions"],
      maxDepth: 4,
    });
    const checked = yield* Effect.forEach(
      liveFirst(files),
      (file) => Effect.map(isRollout(file.absolutePath), (accepted) => ({ file, accepted })),
      { concurrency: 8 },
    );
    return checked.flatMap(({ accepted, file }): ReadonlyArray<SourceDescriptor> =>
      accepted ? [{ kind: "jsonl", root, relativePath: file.relativePath }] : [],
    );
  }),
};
