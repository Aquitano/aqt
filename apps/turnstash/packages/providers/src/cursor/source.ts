import {
  appDataDir,
  type HostEnv,
  type SourceDescriptor,
  type SourceProvider,
  type SourceRoot,
} from "@aqt/turnstash-core";
import { Effect, FileSystem, Path } from "effect";

const databaseName = "state.vscdb";

const installations = ["Cursor", "Cursor Nightly"] as const;

const separatorOf = (host: HostEnv): string => (host.os === "win32" ? "\\" : "/");

const parentOf = (path: string): string => {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return ".";
  return index === 0 ? path.slice(0, 1) : path.slice(0, index);
};

const overrideRoots = (host: HostEnv): ReadonlyArray<SourceRoot> => {
  const configured = host.env["TURNSTASH_CURSOR_DB"]?.trim();
  if (configured === undefined || configured === "") return [];
  const path = configured.replace(/[\\/]+$/, "");
  return [
    { path: path.endsWith(databaseName) ? parentOf(path) : path, label: "TURNSTASH_CURSOR_DB" },
  ];
};

const roots = (host: HostEnv): ReadonlyArray<SourceRoot> => [
  ...overrideRoots(host),
  ...installations.map((installation) => ({
    path: [appDataDir(host), installation, "User", "globalStorage"].join(separatorOf(host)),
    label: installation,
  })),
];

// `LIKE 'bubbleId:%'` scans the whole table; the half-open key ranges seek the UNIQUE index on `key`.
const diskKvRange =
  "(key >= 'bubbleId:' AND key < 'bubbleId;') OR (key >= 'composerData:' AND key < 'composerData;')";

export const cursorSource: SourceProvider = {
  id: "cursor",
  roots,
  discover: Effect.fn("Cursor.discover")(function* (root: SourceRoot) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const database = yield* fs.exists(path.join(root.path, databaseName));
    if (!database) return [];
    return [
      {
        kind: "sqlite",
        root,
        relativePath: databaseName,
        table: "cursorDiskKV",
        keyColumn: "key",
        where: diskKvRange,
      },
      {
        kind: "sqlite",
        root,
        relativePath: databaseName,
        table: "composerHeaders",
        keyColumn: "composerId",
      },
    ] satisfies ReadonlyArray<SourceDescriptor>;
  }),
};
