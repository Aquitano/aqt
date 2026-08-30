# Album

A web app for building photo albums that feel like physical ones. TanStack Start
on a single Cloudflare Worker, with D1 for data and R2 for photos.

The full design is in [docs/DESIGN.md](docs/DESIGN.md) — stack, data model,
routes and the book/editor architecture. This README only covers setup.

## Setup

```sh
bun install
```

### Environment

Copy the examples and fill in your Clerk keys from
<https://dashboard.clerk.com> → API keys:

```sh
cp .env.example .env          # read by Vite during `bun run dev`
cp .dev.vars.example .dev.vars # read by the Worker runtime
```

Both files hold `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. For
production, push the secret with `bunx wrangler secret put CLERK_SECRET_KEY`.

Real keys are required even for local dev: Clerk's keyless fallback cannot
persist its temporary keys under workerd, so without them every server-rendered
page, including public share links, fails with a handshake error.

### Cloudflare resources

```sh
bunx wrangler login
bunx wrangler d1 create album           # paste the uuid into wrangler.jsonc
bunx wrangler r2 bucket create album-photos
```

### Migrations

```sh
bun run db:generate       # drizzle-kit, after editing src/server/db/schema.ts
bun run db:migrate:local  # applies to the local D1 in .wrangler/
bun run db:migrate:remote # applies to the real D1
```

## Develop

```sh
bun run dev        # http://localhost:3000
bun run typecheck
bun run build
```

## Deploy

```sh
bun run build
bun run deploy
```

`bun run cf-typegen` regenerates `worker-configuration.d.ts` after changing
bindings in `wrangler.jsonc`.

## CLI and MCP

`cli/` is a bun workspace with a command line client for the JSON API. It runs
straight from source:

```sh
alias album="bun $(pwd)/cli/src/main.ts"
album login --url https://your-app.workers.dev --key alb_...   # key from the shelf's key icon
album photos import ~/Pictures/trip/*.jpg                       # resized locally, EXIF dates kept
album albums create "Summer" --material cloth --color sand
album book get <album id> > book.json                           # edit, then:
album book put <album id> book.json
album share on <album id>
album export <album id> --out summer.pdf                        # needs: bunx playwright install chromium
```

`album mcp` serves the same operations over MCP on stdio, with a layout guide
and the book's JSON schema as resources, so an agent can lay out a book. For
Claude Code:

```sh
claude mcp add album -- bun /path/to/aqt-img/cli/src/main.ts mcp
```

Config lives in `~/.config/album/config.json`; `ALBUM_URL` and `ALBUM_API_KEY`
override it, which is the way to pass credentials to an MCP host.

The API itself is documented in [docs/DESIGN.md](docs/DESIGN.md#json-api).

## Status

v1 is complete: book, editor, sharing, JSON API, CLI, MCP and PDF export.
Remote D1/R2 and the deploy have not been exercised yet.
