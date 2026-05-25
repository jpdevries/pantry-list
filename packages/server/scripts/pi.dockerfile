# Pi-flavored runtime image for pantry-server.
#
# Built by scripts/build-pi.sh after `cross build --release --target=…`. The
# binary statically links rustls and bundles the SQLite C source, so the base
# image only needs to supply libc + ca-certificates.
#
# Per-target base images (set by build-pi.sh via --build-arg BASE_IMAGE):
#   armv6           -> balenalib/rpi-raspbian:bookworm    (single-arch armv6+VFPv2;
#                                                          Balena's base-image line
#                                                          is deprecated upstream
#                                                          but the layers still pull)
#   armv7, arm64    -> debian:bookworm-slim               (officially maintained,
#                                                          what Raspberry Pi OS is
#                                                          built on)
# There is no Docker Official Image for Raspberry Pi; these are the closest
# userlands. Override via --build-arg BASE_IMAGE=… if you have something else.
#
# Build context is packages/server/.

ARG BASE_IMAGE=debian:bookworm-slim
FROM ${BASE_IMAGE}

ARG BINARY_PATH

# ca-certificates: outbound HTTPS (Anthropic API, /fetch-recipe).
# sqlite3: used only by the integration-test harness in docker mode — the
#   harness's resetDb() shells out to `docker exec <cid> sqlite3` to reset
#   state between tests, because opening WAL-mode SQLite from the host across
#   Docker Desktop's bind-mount doesn't coordinate locks reliably.
# (pantry-server itself doesn't need libsqlite — rusqlite bundles SQLite —
#  or libssl — reqwest uses rustls-tls.)
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/*

COPY ${BINARY_PATH} /usr/local/bin/pantry-server
RUN chmod +x /usr/local/bin/pantry-server

ENV GRAPHQL_PORT=4001 \
    SQLITE_DB_PATH=/var/lib/pantry-host/pantry.db \
    UPLOADS_DIR=/var/lib/pantry-host/uploads \
    RUST_LOG=info

RUN mkdir -p /var/lib/pantry-host/uploads
VOLUME ["/var/lib/pantry-host"]

EXPOSE 4001
ENTRYPOINT ["/usr/local/bin/pantry-server"]
