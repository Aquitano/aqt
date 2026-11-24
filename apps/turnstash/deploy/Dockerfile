# Build context is the workspace root (aqt/), not this directory: the lockfile is resolved
# against every workspace manifest. Dockerfile.dockerignore limits the context to those
# manifests, turnstash and the shared TypeScript packages the web UI builds from.
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS web
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --filter aqt-turnstash --filter @aqt/turnstash-web
RUN bun run --cwd apps/turnstash/apps/web build

FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643
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
