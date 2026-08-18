# syntax=docker/dockerfile:1

# The binary is static and the runtime image holds nothing else: no shell, no
# package manager, no libc. If the archive is going to sit on a box that is
# reachable from a tailnet, the process serving it should have as little around
# it as possible.

FROM golang:1.26.6-alpine AS build
WORKDIR /src

# Dependencies first, so a source-only change reuses the module cache.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO off keeps the binary static, which is what makes the distroless base
# work; -trimpath keeps build paths out of it.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bank ./cmd/bank

# distroless/static carries the CA bundle Gmail's API needs and nothing else.
# The tz database is compiled into the binary instead (see cmd/bank/main.go).
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/bank /usr/local/bin/bank

# 65532 is distroless's "nonroot". The data directory on the host has to be
# owned by it, or by whatever uid docker-compose.yml overrides it with.
USER 65532:65532

ENV BANK_DATA_DIR=/data
EXPOSE 8480

ENTRYPOINT ["/usr/local/bin/bank"]
# Bound to every interface *inside* the container: the container's own loopback
# is not reachable from anywhere, so exposure is decided by which host address
# the port is published on. docker-compose.yml publishes it on a tailnet
# address only.
CMD ["serve", "--listen", "0.0.0.0:8480"]
