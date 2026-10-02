# syntax=docker/dockerfile:1

# A static binary on distroless, like bank: the process holding a browsing
# history on a box reachable from the tailnet keeps nothing else around it, no
# shell, no package manager, no libc.

FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src

# Dependencies first, so a source-only change reuses the module cache.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Declared after the module download, so a new commit only rebuilds the binary.
ARG GIT_SHA=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${GIT_SHA}" -o /out/tracker ./cmd/tracker

# distroless/static carries the CA bundle OIDC discovery needs and nothing else.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

COPY --from=build /out/tracker /usr/local/bin/tracker

# 65532 is distroless's "nonroot". The server writes nothing to disk: every
# byte it keeps is in Postgres.
USER 65532:65532
EXPOSE 8490

ENTRYPOINT ["/usr/local/bin/tracker"]
# Every interface *inside* the container, whose own loopback nothing can reach:
# exposure is decided by the host address docker-compose.yml publishes on.
CMD ["serve", "--listen", "0.0.0.0:8490"]
