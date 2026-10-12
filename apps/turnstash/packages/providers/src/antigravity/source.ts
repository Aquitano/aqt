import {
  type HostEnv,
  isExcludedPath,
  type SourceDescriptor,
  type SourceProvider,
  type SourceRoot,
} from "@aqt/turnstash-core";
import { Effect, FileSystem, Path } from "effect";

import { joinFrom } from "../roots.ts";

const appDirectories = ["antigravity-cli", "antigravity", "antigravity-ide"] as const;

const roots = (host: HostEnv): ReadonlyArray<SourceRoot> => {
  const override = host.env["ANTIGRAVITY_DATA_DIR"]?.trim();
  if (override !== undefined && override !== "")
    return [{ path: override, label: "Antigravity (ANTIGRAVITY_DATA_DIR)" }];
  return appDirectories.map((app) => ({
    path: joinFrom(host, host.home, ".gemini", app),
    label: app,
  }));
};

const transcriptNames = ["transcript_full.jsonl", "transcript.jsonl"] as const;

// Only the usage rows are read from SQLite; tool arguments and the workspace path live in the plain-text
// transcript, which is what secret redaction can inspect.
export const antigravitySource: SourceProvider = {
  id: "antigravity",
  roots,
  discover: Effect.fn("Antigravity.discover")(function* (root: SourceRoot) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs
      .readDirectory(path.join(root.path, "conversations"))
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed<ReadonlyArray<string>>([]),
        ),
      );
    const descriptors: Array<SourceDescriptor> = [];
    for (const entry of entries
      .filter((name) => name.endsWith(".db") && !isExcludedPath(name))
      .sort()) {
      const conversationId = entry.slice(0, -3);
      const relativePath = `conversations/${entry}`;
      descriptors.push({
        kind: "sqlite",
        root,
        relativePath,
        table: "gen_metadata",
        keyColumn: "idx",
      });
      for (const name of transcriptNames) {
        const transcript = `brain/${conversationId}/.system_generated/logs/${name}`;
        if (yield* fs.exists(path.join(root.path, transcript))) {
          descriptors.push({ kind: "jsonl", root, relativePath: transcript });
          break;
        }
      }
    }
    return descriptors;
  }),
};
