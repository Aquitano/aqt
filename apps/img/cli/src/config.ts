import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type } from "arktype";

export type Config = { url: string; key: string };

const storedConfig = type({ "url?": "string", "key?": "string" });

const FILE = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "album",
  "config.json",
);

/** A missing, unreadable or malformed file means nothing is configured yet. */
async function readStoredConfig(): Promise<typeof storedConfig.infer> {
  const raw = await readFile(FILE, "utf8").catch(() => null);
  if (raw === null) return {};
  try {
    const stored = storedConfig(JSON.parse(raw));
    return stored instanceof type.errors ? {} : stored;
  } catch {
    return {};
  }
}

/** Env vars win over the config file, so scripts and MCP hosts can inject them. */
export async function loadConfig(): Promise<Config> {
  const stored = await readStoredConfig();
  const url = process.env.ALBUM_URL ?? stored.url;
  const key = process.env.ALBUM_API_KEY ?? stored.key;
  if (!url || !key) {
    throw new Error(
      `Not logged in. Run \`album login --url <app url> --key <api key>\` or set ALBUM_URL and ALBUM_API_KEY.`,
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

export async function saveConfig(config: Config) {
  await mkdir(join(FILE, ".."), { recursive: true });
  await writeFile(FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return FILE;
}
