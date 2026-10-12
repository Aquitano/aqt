import type { HostEnv, SourceDescriptor, SourceProvider, SourceRoot } from "@aqt/turnstash-core";
import { Effect } from "effect";

import { walkFiles } from "../walk.ts";

const products = [
  { label: "pi", envVar: "PI_SESSIONS_DIR", directory: ".pi" },
  { label: "omp", envVar: "OMP_SESSIONS_DIR", directory: ".omp" },
] as const;

// <root>/<project-slug>/<parent-session>/<agent>.jsonl is the deepest layout Pi and OMP write.
const layoutDepth = 3;

const sessionsPath = (host: HostEnv, directory: string): string =>
  [host.home, directory, "agent", "sessions"].join(host.os === "win32" ? "\\" : "/");

const distinctByPath = (roots: ReadonlyArray<SourceRoot>): ReadonlyArray<SourceRoot> => {
  const seen = new Set<string>();
  const distinct: Array<SourceRoot> = [];
  for (const root of roots) {
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    distinct.push(root);
  }
  return distinct;
};

export const piSource: SourceProvider = {
  id: "pi",
  roots: (host) =>
    distinctByPath([
      ...products.flatMap((product) => {
        const override = host.env[product.envVar];
        return override === undefined || override === ""
          ? []
          : [{ path: override, label: product.label }];
      }),
      ...products.map((product) => ({
        path: sessionsPath(host, product.directory),
        label: product.label,
      })),
    ]),
  discover: (root) =>
    walkFiles(root, (relativePath) => relativePath.endsWith(".jsonl"), {
      maxDepth: layoutDepth,
    }).pipe(
      Effect.map((files) =>
        files.map((file): SourceDescriptor => ({
          kind: "jsonl",
          root,
          relativePath: file.relativePath,
        })),
      ),
    ),
};
