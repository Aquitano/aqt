#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { type } from "arktype";

import { bookInput } from "@/domain/api";

import { ApiError, createClient } from "./client";
import { loadConfig, saveConfig } from "./config";
import { bookDocument, coverFrom, importPhotos } from "./ops";

const USAGE = `album - photo books from the terminal

  album login --url <app url> --key <api key>
  album whoami
  album albums list
  album albums create <title> [--material linen|leather|cloth] [--color oxblood|forest|navy|sand|charcoal|cream|<css color>]
  album albums delete <album id>
  album photos list
  album photos import <file...>
  album photos delete <photo id>
  album book get <album id>            prints the book as JSON
  album book put <album id> [file|-]   replaces the book from JSON (stdin by default)
  album share on|off <album id>
  album export <album id> [--out book.pdf]
  album mcp                            serve the same commands over MCP (stdio)

  --json on any command prints raw API responses.`;

type Flags = {
  json: boolean;
  url?: string;
  key?: string;
  material?: string;
  color?: string;
  out?: string;
};

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      url: { type: "string" },
      key: { type: "string" },
      material: { type: "string" },
      color: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const flags: Flags = values;
  const [command, ...rest] = positionals;
  if (values.help || !command) return print(USAGE);

  if (command === "login") {
    if (!flags.url || !flags.key) throw new UsageError("login needs --url and --key");
    const client = createClient({ url: flags.url, key: flags.key });
    const { userId } = await client.me();
    const file = await saveConfig({ url: client.url, key: flags.key });
    return print(`Logged in as ${userId}. Saved to ${file}`);
  }

  if (command === "mcp") {
    const { serveMcp } = await import("./mcp");
    return serveMcp(createClient(await loadConfig()));
  }

  const client = createClient(await loadConfig());
  const out = (data: unknown, human: () => string) =>
    print(flags.json ? JSON.stringify(data, null, 2) : human());

  if (command === "export") {
    const { exportPdf } = await import("./export");
    const file = await exportPdf(client, need(rest[0], "album id"), flags.out);
    return out({ file }, () => `Wrote ${file}`);
  }

  switch (`${command} ${rest[0] ?? ""}`.trim()) {
    case "whoami": {
      const me = await client.me();
      return out(me, () => `${me.userId} at ${client.url}`);
    }
    case "albums list": {
      const albums = await client.albums.list();
      return out(albums, () =>
        albums.length === 0
          ? "No albums."
          : albums
              .map(
                (a) =>
                  `${a.id}  ${a.title}${a.shareSlug ? `  (shared: ${client.url}/s/${a.shareSlug})` : ""}`,
              )
              .join("\n"),
      );
    }
    case "albums create": {
      const title = rest.slice(1).join(" ").trim();
      if (!title) throw new UsageError("albums create needs a title");
      const album = await client.albums.create({ title, cover: coverFrom(flags) });
      return out(album, () => `${album.id}  ${album.title}`);
    }
    case "albums delete": {
      await client.albums.delete(need(rest[1], "album id"));
      return out({ ok: true }, () => "Deleted.");
    }
    case "photos list": {
      const photos = await client.photos.list();
      return out(photos, () =>
        photos.length === 0
          ? "No photos."
          : photos
              .map(
                (p) =>
                  `${p.id}  ${p.width}x${p.height}  ${p.takenAt ? new Date(p.takenAt).toISOString().slice(0, 10) : "no date"}`,
              )
              .join("\n"),
      );
    }
    case "photos import": {
      const files = rest.slice(1);
      if (files.length === 0) throw new UsageError("photos import needs at least one file");
      const imported = await importPhotos(client, files, (line) =>
        flags.json ? undefined : print(line),
      );
      return flags.json
        ? print(JSON.stringify(imported, null, 2))
        : print(`Imported ${imported.length} photo(s).`);
    }
    case "photos delete": {
      await client.photos.delete(need(rest[1], "photo id"));
      return out({ ok: true }, () => "Deleted.");
    }
    case "book get": {
      const book = await client.albums.get(need(rest[1], "album id"));
      return print(JSON.stringify(bookDocument(book), null, 2));
    }
    case "book put": {
      const albumId = need(rest[1], "album id");
      const source =
        rest[2] && rest[2] !== "-" ? await readFile(rest[2], "utf8") : await readStdin();
      const parsed = bookInput(JSON.parse(source));
      if (parsed instanceof type.errors) throw new UsageError(`Invalid book:\n${parsed.summary}`);
      const book = await client.albums.putBook(albumId, parsed);
      return out(book, () => `Saved ${book.spreads.length} spread(s) to "${book.album.title}".`);
    }
    case "share on": {
      const share = await client.albums.share(need(rest[1], "album id"));
      return out(share, () => share.url);
    }
    case "share off": {
      await client.albums.unshare(need(rest[1], "album id"));
      return out({ ok: true }, () => "Sharing is off.");
    }
    default:
      throw new UsageError(`Unknown command: ${[command, ...rest].join(" ")}\n\n${USAGE}`);
  }
}

function need(value: string | undefined, what: string) {
  if (!value) throw new UsageError(`Missing ${what}`);
  return value;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function print(text: string) {
  process.stdout.write(text + "\n");
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message =
    error instanceof ApiError
      ? `${error.message} (${error.status})`
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(message + "\n");
  process.exit(error instanceof UsageError ? 2 : 1);
});
