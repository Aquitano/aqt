# syntax=docker/dockerfile:1

# A static binary on distroless, like bank: the process holding a browsing
# history on a box reachable from the tailnet keeps nothing else around it, no
# shell, no package manager, no libc.

FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src/apps/tracker

# The context is the repository root, because tracker builds against
# packages/go/pgschema (Dockerfile.dockerignore keeps everything else out).
# Dependencies first, so a source-only change reuses the module cache.
COPY packages/go/pgschema/go.mod packages/go/pgschema/go.sum /src/packages/go/pgschema/
COPY apps/tracker/go.mod apps/tracker/go.sum ./
RUN go mod download

COPY packages/go/pgschema /src/packages/go/pgschema
COPY apps/tracker ./
# Declared after the module download, so a new commit only rebuilds the binary.
ARG GIT_SHA=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${GIT_SHA}" -o /out/tracker ./cmd/tracker

# distroless/static carries the CA bundle OIDC discovery needs and nothing else.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99

COPY --from=build /out/tracker /usr/local/bin/tracker

# 65532 is distroless's "nonroot". The server writes nothing to disk: every
# byte it keeps is in Postgres.
USER 65532:65532
EXPOSE 8490

ENTRYPOINT ["/usr/local/bin/tracker"]
# Every interface *inside* the container, whose own loopback nothing can reach:
# exposure is decided by the host address docker-compose.yml publishes on. Not
# being loopback, it makes serve require TRACKER_OIDC_ISSUER.
CMD ["serve", "--listen", "0.0.0.0:8490"]
