import { Database } from "bun:sqlite";

import {
  appDataDir,
  type HostEnv,
  type SourceDescriptor,
  type SourceProvider,
  type SourceRoot,
  type SqliteTableSource,
} from "@aqt/turnstash-core";
import { Effect } from "effect";

import { walkFiles } from "../walk.ts";
import { readVscodeChat } from "./vscode.ts";

const vscodeVariants = ["Code", "Code - Insiders", "VSCodium"] as const;

const parentDirectory = (path: string): string => {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator <= 0 ? path : path.slice(0, separator);
};

const roots = (host: HostEnv): ReadonlyArray<SourceRoot> => {
  const join = (...segments: ReadonlyArray<string>) =>
    segments.join(host.os === "win32" ? "\\" : "/");
  const found = new Map<string, SourceRoot>();
  const add = (path: string, label: string) => {
    if (path !== "" && !found.has(path)) found.set(path, { path, label });
  };

  const sessionState = host.env["TURNSTASH_COPILOT_SESSION_STATE_DIR"];
  if (sessionState !== undefined) add(sessionState, "copilot-cli-sessions");
  else if (host.home !== "")
    add(join(host.home, ".copilot", "session-state"), "copilot-cli-sessions");

  const store = host.env["TURNSTASH_COPILOT_SESSION_STORE_DB"];
  if (store !== undefined) add(parentDirectory(store), "copilot-cli-store");
  else if (host.home !== "") add(join(host.home, ".copilot"), "copilot-cli-store");

  const globalStorage = host.env["TURNSTASH_COPILOT_GLOBAL_STORAGE_DIR"];
  if (globalStorage !== undefined && globalStorage !== "")
    add(join(globalStorage, "github.copilot-chat"), "copilot-vscode-store");
  else {
    const appData = appDataDir(host);
    if (appData !== "") {
      for (const variant of vscodeVariants) {
        add(
          join(appData, variant, "User", "globalStorage", "github.copilot-chat"),
          "copilot-vscode-store",
        );
      }
    }
  }
  const workspaceStorage = host.env["TURNSTASH_COPILOT_WORKSPACE_STORAGE_DIR"];
  if (workspaceStorage !== undefined) add(workspaceStorage, "copilot-vscode-chats");
  else if (host.home !== "") {
    for (const variant of vscodeVariants) {
      add(join(appDataDir(host), variant, "User", "workspaceStorage"), "copilot-vscode-chats");
    }
  }
  return [...found.values()];
};

interface StoreTable {
  readonly table: string;
  readonly keyColumn: string;
  readonly required: ReadonlyArray<string>;
}

const storeTables: ReadonlyArray<StoreTable> = [
  { table: "assistant_usage_events", keyColumn: "id", required: ["id", "session_id", "model"] },
  { table: "sessions", keyColumn: "id", required: ["id"] },
  { table: "turns", keyColumn: "id", required: ["id", "session_id"] },
];

const columnsOf = (db: Database, table: string): ReadonlySet<string> =>
  new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  );

const storeDescriptors = (
  root: SourceRoot,
  relativePath: string,
  absolutePath: string,
): ReadonlyArray<SqliteTableSource> => {
  let db: Database | undefined;
  try {
    db = new Database(absolutePath, { readonly: true });
    const descriptors: Array<SqliteTableSource> = [];
    for (const candidate of storeTables) {
      const columns = columnsOf(db, candidate.table);
      if (!candidate.required.every((column) => columns.has(column))) continue;
      descriptors.push({
        kind: "sqlite",
        root,
        relativePath,
        table: candidate.table,
        keyColumn: candidate.keyColumn,
      });
    }
    return descriptors;
  } catch {
    // A locked, corrupt or half-replaced store yields no descriptor, which leaves the agent's
    // checkpoint where it is so the stream is retried on the next pass.
    return [];
  } finally {
    db?.close();
  }
};

const accept = (relativePath: string): boolean =>
  relativePath.endsWith("/events.jsonl") ||
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.jsonl$/i.test(relativePath) ||
  relativePath.endsWith(".db");

const storeRootLabels = new Set(["copilot-cli-store", "copilot-vscode-store"]);

const walkDepth = (root: SourceRoot): number => (storeRootLabels.has(root.label) ? 1 : 2);

export const copilotSource: SourceProvider = {
  id: "copilot",
  roots,
  discover: Effect.fn("Copilot.discover")(function* (root: SourceRoot) {
    if (root.label === "copilot-vscode-chats") {
      const files = yield* walkFiles(
        root,
        (relativePath) => /^[^/]+\/chatSessions\/[^/]+\.jsonl?$/.test(relativePath),
        { maxDepth: 3 },
      );
      return files.map((file): SourceDescriptor => ({
        kind: "json",
        root,
        relativePath: file.relativePath,
        readRecords: readVscodeChat,
      }));
    }
    const files = yield* walkFiles(root, accept, { maxDepth: walkDepth(root) });
    const descriptors: Array<SourceDescriptor> = [];
    for (const file of files) {
      if (file.relativePath.endsWith(".db")) {
        descriptors.push(...storeDescriptors(root, file.relativePath, file.absolutePath));
      } else {
        descriptors.push({ kind: "jsonl", root, relativePath: file.relativePath });
      }
    }
    return descriptors;
  }),
};
