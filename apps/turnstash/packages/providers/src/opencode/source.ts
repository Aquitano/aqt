import {
  hostEnvFromProcess,
  isExcludedPath,
  type HostEnv,
  type SourceDescriptor,
  type SourceProvider,
  type SourceRoot,
} from "@aqt/turnstash-core";
import { Effect, FileSystem, Path } from "effect";

import { distinctRoots, joinFrom } from "../roots.ts";
import { walkFiles } from "../walk.ts";

const scannedTables = ["session_v2", "session_message", "session", "message", "part"] as const;

const fileStoreDirectories = ["session", "message", "part"] as const;

const defaultDbPrefix = "opencode";

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result === undefined || result === "" ? undefined : result;
};

const dataHome = (host: HostEnv): string =>
  trimmed(host.env["XDG_DATA_HOME"]) ?? joinFrom(host, host.home, ".local", "share");

const opencodeDbPrefix = (env: HostEnv["env"]): string =>
  trimmed(env["OPENCODE_DB_PREFIX"]) ?? defaultDbPrefix;

const roots = (host: HostEnv): ReadonlyArray<SourceRoot> => {
  const override = trimmed(host.env["OPENCODE_DATA_DIR"]);
  const candidates: ReadonlyArray<SourceRoot> = [
    ...(override === undefined ? [] : [{ path: override, label: "opencode (OPENCODE_DATA_DIR)" }]),
    { path: joinFrom(host, dataHome(host), "opencode"), label: "opencode" },
  ];
  return distinctRoots(candidates);
};

export const opencodeSource: SourceProvider = {
  id: "opencode",
  roots,
  discover: Effect.fn("Opencode.discover")(function* (root: SourceRoot) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // discover() is handed a root, not the HostEnv, so the db prefix override is read here.
    const prefix = opencodeDbPrefix(hostEnvFromProcess().env);
    const entries = yield* fs
      .readDirectory(root.path)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed<ReadonlyArray<string>>([]),
        ),
      );
    const databases = entries
      .filter(
        (entry) => entry.startsWith(prefix) && entry.endsWith(".db") && !isExcludedPath(entry),
      )
      .toSorted();
    const descriptors: Array<SourceDescriptor> = databases.flatMap((relativePath) =>
      scannedTables.map((table) => ({
        kind: "sqlite" as const,
        root,
        relativePath,
        table,
        keyColumn: "id",
      })),
    );
    for (const directory of fileStoreDirectories) {
      const store = { path: path.join(root.path, "storage", directory), label: root.label };
      const files = yield* walkFiles(store, (relativePath) => relativePath.endsWith(".json"), {
        maxDepth: 3,
      });
      for (const file of files) {
        descriptors.push({
          kind: "json",
          root,
          relativePath: `storage/${directory}/${file.relativePath}`,
        });
      }
    }
    return descriptors;
  }),
};
