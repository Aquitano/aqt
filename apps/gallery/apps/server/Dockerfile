# Build context is the workspace root (aqt/), not this directory: the lockfile
# is resolved against every workspace manifest, and the filter below installs
# only what this server and its workspace dependencies need.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --filter @aqt/gallery-server

ARG GIT_SHA=unknown
ENV NODE_ENV=production PORT=3000 DOTENV_CONFIG_QUIET=true GIT_SHA=$GIT_SHA
EXPOSE 3000
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/').then((r) => { if (!r.ok) throw r.status })"
CMD ["bun", "apps/gallery/apps/server/src/index.ts"]
