import { isExcludedPath, type SourceRoot } from "@aqt/turnstash-core";
import { Effect, FileSystem, Option, Order, Path, Schema } from "effect";

export interface WalkedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

const skippedDirectories = new Set(["node_modules", ".git"]);

export const walkFiles = Effect.fn("Sources.walkFiles")(function* (
  root: SourceRoot,
  accept: (relativePath: string) => boolean,
  options: { readonly maxDepth?: number; readonly within?: ReadonlyArray<string> } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxDepth = yield* Schema.decodeUnknownEffect(Schema.Natural)(options.maxDepth ?? 12);
  const files: Array<WalkedFile> = [];
  const directories = (options.within ?? [""]).map((relativePath) => ({ relativePath, depth: 0 }));
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined || directory.depth >= maxDepth) continue;
    const entries = yield* fs
      .readDirectory(path.join(root.path, directory.relativePath))
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    for (const entry of entries.toSorted(Order.String)) {
      if (skippedDirectories.has(entry) || isExcludedPath(entry)) continue;
      const relativePath =
        directory.relativePath === "" ? entry : `${directory.relativePath}/${entry}`;
      const absolutePath = path.join(root.path, relativePath);
      const info = yield* fs.stat(absolutePath).pipe(
        Effect.map(Option.some),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
      );
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory") {
        directories.push({ relativePath, depth: directory.depth + 1 });
      } else if (info.value.type === "File" && accept(relativePath)) {
        files.push({ relativePath, absolutePath });
      }
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
});
