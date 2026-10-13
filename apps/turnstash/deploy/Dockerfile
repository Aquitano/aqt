# Build context is the workspace root (aqt/), not this directory: the lockfile is resolved
# against every workspace manifest. Dockerfile.dockerignore limits the context to those
# manifests, turnstash and the shared TypeScript packages the web UI builds from.
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS web
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --filter aqt-turnstash --filter @aqt/turnstash-web
RUN bun run --cwd apps/turnstash/apps/web build

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4320
ENV WEB_DIST=/app/apps/turnstash/apps/web/dist
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --filter @aqt/turnstash-server
COPY --from=web /app/apps/turnstash/apps/web/dist ./apps/turnstash/apps/web/dist
EXPOSE 4320
CMD ["bun", "apps/turnstash/apps/server/src/main.ts"]
