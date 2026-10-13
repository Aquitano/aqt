import {
  appDataDir,
  type HostEnv,
  localAppDataDir,
  type SourceDescriptor,
  type SourceProvider,
  type SourceRoot,
} from "@aqt/turnstash-core";
import { Effect, FileSystem, Path } from "effect";

import { distinctRoots } from "../roots.ts";
import { walkFiles } from "../walk.ts";

const separatorOf = (host: HostEnv) => (host.os === "win32" ? "\\" : "/");

const joinPath = (host: HostEnv, ...segments: ReadonlyArray<string>) =>
  segments.join(separatorOf(host));

const expandHome = (host: HostEnv, value: string) =>
  value === "~"
    ? host.home
    : /^~[/\\]/.test(value)
      ? joinPath(host, host.home, value.slice(2))
      : value;

const configDirs = (host: HostEnv): ReadonlyArray<string> => {
  const entries = (host.env["CLAUDE_CONFIG_DIRS"] ?? "")
    .split(host.os === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length > 0) return entries.map((entry) => expandHome(host, entry));
  const single = host.env["CLAUDE_CONFIG_DIR"]?.trim();
  if (single !== undefined && single.length > 0) return [expandHome(host, single)];
  return [joinPath(host, host.home, ".claude")];
};

const packagesDirectory = "Packages";
const msixSessionsPath = "LocalCache/Roaming/Claude/local-agent-mode-sessions";

const desktopDirs = (host: HostEnv): ReadonlyArray<string> => {
  const override = host.env["TURNSTASH_DESKTOP_SESSIONS_DIR"]?.trim();
  if (override !== undefined && override.length > 0) return [expandHome(host, override)];
  const classic = joinPath(host, appDataDir(host), "Claude", "local-agent-mode-sessions");
  return host.os === "win32"
    ? [classic, joinPath(host, localAppDataDir(host), packagesDirectory)]
    : [classic];
};

const roots = (host: HostEnv): ReadonlyArray<SourceRoot> => {
  const configured = configDirs(host);
  const defaultConfigDir = joinPath(host, host.home, ".claude");
  return [
    ...distinctRoots(
      configured.map((path) => ({
        path,
        label: path === defaultConfigDir ? "Claude Code" : `Claude Code (${path})`,
      })),
    ),
    ...distinctRoots(
      desktopDirs(host).map((path) => ({
        path,
        label: path.endsWith(packagesDirectory) ? "Claude Desktop (MSIX)" : "Claude Desktop",
      })),
    ),
  ];
};

interface SearchTree {
  readonly relativePath: string;
  readonly maxDepth: number;
}

// MSIX package names are only knowable from disk while `roots` is pure, so the packages
// directory is itself a root and the Claude packages inside it are expanded here.
const msixTrees = Effect.fn("Claude.msixTrees")(function* (root: SourceRoot) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(root.path)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<ReadonlyArray<string>>([]),
      ),
    );
  return entries
    .filter((entry) => entry.startsWith("Claude_") || entry.includes(".Claude_"))
    .sort()
    .map(
      (entry) =>
        ({ relativePath: `${entry}/${msixSessionsPath}`, maxDepth: 12 }) satisfies SearchTree,
    );
});

const searchTrees = Effect.fn("Claude.searchTrees")(function* (root: SourceRoot) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (path.basename(root.path) === packagesDirectory) return yield* msixTrees(root);
  const hasProjects = yield* fs.exists(path.join(root.path, "projects"));
  return hasProjects
    ? [{ relativePath: "projects", maxDepth: 6 } satisfies SearchTree]
    : [{ relativePath: "", maxDepth: 12 } satisfies SearchTree];
});

const transcriptName = /^agent-.+\.jsonl$/;
const metaName = /^agent-.+\.meta\.json$/;

const accepts = (relativePath: string): boolean => {
  const segments = relativePath.split("/");
  const projects = segments.lastIndexOf("projects");
  if (projects < 0 || segments.length < projects + 3) return false;
  const tail = segments.slice(projects + 2);
  const name = tail[tail.length - 1] ?? "";
  if (tail.length === 1) return name.endsWith(".jsonl");
  if (!tail.includes("subagents")) return false;
  return transcriptName.test(name) || metaName.test(name);
};

const discover = Effect.fn("Claude.discover")(function* (root: SourceRoot) {
  const path = yield* Path.Path;
  const trees = yield* searchTrees(root);
  const descriptors: Array<SourceDescriptor> = [];
  for (const tree of trees) {
    const treeRoot =
      tree.relativePath === ""
        ? root
        : { path: path.join(root.path, ...tree.relativePath.split("/")), label: root.label };
    const prefix = tree.relativePath === "" ? "" : `${tree.relativePath}/`;
    const files = yield* walkFiles(
      treeRoot,
      (relativePath) => accepts(`${prefix}${relativePath}`),
      {
        maxDepth: tree.maxDepth,
      },
    );
    for (const file of files) {
      const relativePath = `${prefix}${file.relativePath}`;
      descriptors.push({
        kind: relativePath.endsWith(".jsonl") ? "jsonl" : "json",
        root,
        relativePath,
      });
    }
  }
  return descriptors.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
});

export const claudeSource: SourceProvider = { id: "claude", roots, discover };
