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

## Status

Phase 1 (scaffolding) only. The book renders a spread as two flat pages; the 3D
page turn, cover materials, transform handles, toolbar, photo library and
filmstrip are phase 2. Places where phase 2 code slots in are marked
`// phase 2`.
