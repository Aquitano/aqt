# syntax=docker/dockerfile:1

# The binary is static and the runtime image holds nothing else: no shell, no
# package manager, no libc. If the archive is going to sit on a box that is
# reachable from a tailnet, the process serving it should have as little around
# it as possible.

FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src/apps/bank

# The context is the repository root, because bank builds against
# packages/go/extract and packages/go/pgschema (Dockerfile.dockerignore keeps
# everything else out). Dependencies first, so a source-only change reuses the
# module cache.
COPY packages/go/extract/go.mod packages/go/extract/go.sum /src/packages/go/extract/
COPY packages/go/pgschema/go.mod packages/go/pgschema/go.sum /src/packages/go/pgschema/
COPY apps/bank/go.mod apps/bank/go.sum ./
RUN go mod download

COPY packages/go/extract /src/packages/go/extract
COPY packages/go/pgschema /src/packages/go/pgschema
COPY apps/bank ./
# CGO off keeps the binary static, which is what makes the distroless base
# work; -trimpath keeps build paths out of it.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/bank ./cmd/bank

# The image the OCR worker runs from (the `ocr` compose profile). It carries
# tesseract and poppler — a C++ image stack and a libc — which is exactly why
# they are not in the image that listens on a port.
FROM debian:13-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS ocr

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-deu poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Further languages are apt packages (tesseract-ocr-fra and so on). Add them
# here and set BANK_OCR_LANG accordingly.

COPY --from=build /out/bank /usr/local/bin/bank
USER 65532:65532
ENV BANK_DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/bank"]
CMD ["extract", "--ocr"]

# distroless/static carries the CA bundle Gmail's API needs and nothing else.
# The tz database is compiled into the binary instead (see cmd/bank/main.go).
#
# This stage is last, so `docker build -f apps/bank/Dockerfile .` from the
# repository root produces the server image.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3 AS server

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
