#!/usr/bin/env bash
# Cross-compile pantry-server for Raspberry Pi targets and verify the binary
# inside a Pi-userland Docker image (QEMU-emulated when the host arch differs).
#
#   ./scripts/build-pi.sh                 # all targets, build + verify
#   ./scripts/build-pi.sh armv7           # one target
#   ./scripts/build-pi.sh --no-verify all # skip the docker run-through
#   ./scripts/build-pi.sh --no-image arm64  # cross-compile only, no docker
#   ./scripts/build-pi.sh --integration arm64  # also run the integration suite
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/../.." && pwd)"
ENV_BUILD="$SCRIPT_DIR/.env.build"
DOCKERFILE="$SCRIPT_DIR/pi.dockerfile"
DIST_DIR="$SERVER_DIR/dist/pi"
SYNC_FRONTEND="$SCRIPT_DIR/sync-frontend.sh"

# target_key -> "<rust target>|<docker platform>|<base verify image>"
#
# armv6 needs an actual armv6+VFPv2 userland — Debian armhf is armv7+VFPv3 and
# won't load the binaries cross produces, and dtcooper/raspberrypi-os only
# ships arm/v7 + arm64 manifests. balenalib/rpi-raspbian is single-arch armv6
# (Pi 1 / Zero); the Balena base-image line is deprecated but the layers still
# pull anonymously and it's the cleanest fit.
TARGETS_armv6="arm-unknown-linux-gnueabihf|linux/arm/v6|balenalib/rpi-raspbian:bookworm"
TARGETS_armv7="armv7-unknown-linux-gnueabihf|linux/arm/v7|debian:bookworm-slim"
TARGETS_arm64="aarch64-unknown-linux-gnu|linux/arm64|debian:bookworm-slim"
ALL_TARGETS=(armv6 armv7 arm64)

DO_BUILD=1
DO_IMAGE=1
DO_VERIFY=1
DO_INTEGRATION=0
# 1: run `npm run build` + sync-frontend.sh before cargo cross-compile so the
# binary has the latest SPA embedded. Set with --skip-frontend when iterating
# on Rust-only changes and the static/ dir is already populated.
DO_FRONTEND=1
REQUESTED=()

usage() {
  cat <<EOF
Usage: $(basename "$0") [options] [targets...]

Targets:   armv6  armv7  arm64  all   (default: all)
Options:
  --no-build      Skip cargo cross-compile (use existing target/release/<triple>/pantry-server)
  --no-image      Skip docker build
  --no-verify     Skip the boot smoke check
  --skip-frontend Skip the frontend rebuild + sync (use whatever's in
                  packages/server/static/ from a previous run)
  --integration   After verify, run npm run test:integration against the built image
                  (slow under QEMU for foreign archs; native arm hosts are fine)
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)    DO_BUILD=0 ;;
    --no-image)    DO_IMAGE=0; DO_VERIFY=0; DO_INTEGRATION=0 ;;
    --no-verify)   DO_VERIFY=0 ;;
    --skip-frontend) DO_FRONTEND=0 ;;
    --integration) DO_INTEGRATION=1 ;;
    -h|--help)     usage; exit 0 ;;
    -*)            echo "unknown flag: $1" >&2; usage; exit 2 ;;
    all)           REQUESTED=("${ALL_TARGETS[@]}") ;;
    armv6|armv7|arm64) REQUESTED+=("$1") ;;
    *) echo "unknown target: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [[ ${#REQUESTED[@]} -eq 0 ]]; then
  REQUESTED=("${ALL_TARGETS[@]}")
fi

target_for() {
  local k="$1" v
  v="$(eval echo "\$TARGETS_${k}")"
  [[ -n "$v" ]] || { echo "no mapping for $k" >&2; exit 2; }
  echo "$v"
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }

if (( DO_BUILD )); then
  need cargo
  need cross || true
  if ! command -v cross >/dev/null 2>&1; then
    echo "error: 'cross' not found." >&2
    echo "  install: cargo install cross --git https://github.com/cross-rs/cross" >&2
    echo "  (per cross-rs docs; toolchain images live at ghcr.io/cross-rs/<target>)" >&2
    exit 1
  fi
  need docker
fi
if (( DO_IMAGE )); then
  need docker
fi

# .env.build is sourced for optional GHCR PAT credentials (see below). It's
# gitignored — never commit credentials.
if [[ -f "$ENV_BUILD" ]]; then
  echo "==> sourcing $ENV_BUILD"
  # shellcheck disable=SC1090
  set -a; source "$ENV_BUILD"; set +a
fi

# Optional ghcr.io login. Some networks need authenticated pulls for the
# cross-rs toolchain images even though they're nominally public; a PAT with
# `read:packages` scope is enough. Credentials live in .env.build (gitignored)
# — never committed.
if [[ -n "${GHCR_PAT:-}" && -n "${GHCR_USER:-}" ]]; then
  echo "==> docker login ghcr.io as $GHCR_USER (PAT from .env.build)"
  echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

mkdir -p "$DIST_DIR"

# Run the frontend build + sync once, up front: every per-target cargo build
# embeds the same static/ tree (it's the same SPA on armv6/armv7/arm64).
if (( DO_BUILD && DO_FRONTEND )); then
  echo "==> rebuilding frontend (packages/app) and syncing to static/"
  "$SYNC_FRONTEND" --build
fi

# Ensure binfmt is registered so the host can exec foreign-arch binaries.
# Safe to run repeatedly; Docker Desktop persists the registration.
if (( DO_VERIFY )); then
  echo "==> registering QEMU binfmt handlers (idempotent)"
  docker run --rm --privileged tonistiigi/binfmt --install all >/dev/null 2>&1 || \
    echo "    (warning: binfmt registration failed; foreign-arch exec may not work)"
fi

build_target() {
  local key="$1" mapping rust_target rest docker_platform base_image
  mapping="$(target_for "$key")"
  rust_target="${mapping%%|*}"
  rest="${mapping#*|}"
  docker_platform="${rest%%|*}"
  base_image="${rest#*|}"

  # Workspace target dir lives at the repo root (Cargo.toml workspace).
  local bin_src="$REPO_ROOT/target/$rust_target/release/pantry-server"
  local out_bin="$DIST_DIR/pantry-server-$key"
  local image_tag="pantry-server:pi-$key"

  echo
  echo "================================================================"
  echo "  $key  ($rust_target, $docker_platform, base=$base_image)"
  echo "================================================================"

  if (( DO_BUILD )); then
    echo "==> cross build --release --target $rust_target -p pantry-server"
    # Run from the repo root so cross mounts the whole workspace (needed for
    # the include_str! into packages/shared/src/sql/schema.sql).
    ( cd "$REPO_ROOT" && cross build --release --target "$rust_target" -p pantry-server )
  fi

  if [[ ! -x "$bin_src" ]]; then
    echo "error: expected binary not found at $bin_src" >&2
    exit 1
  fi
  cp "$bin_src" "$out_bin"
  echo "==> binary: $out_bin ($(du -h "$out_bin" | cut -f1))"

  if (( DO_IMAGE )); then
    echo "==> docker build $image_tag (base=$base_image)"
    docker build \
      --platform "$docker_platform" \
      --file "$DOCKERFILE" \
      --build-arg "BASE_IMAGE=$base_image" \
      --build-arg "BINARY_PATH=dist/pi/pantry-server-$key" \
      --tag "$image_tag" \
      "$SERVER_DIR"
  fi

  if (( DO_VERIFY )); then
    verify_image "$image_tag" "$docker_platform" "$key"
  fi

  if (( DO_INTEGRATION )); then
    run_integration "$image_tag" "$docker_platform" "$key"
  fi
}

run_integration() {
  local image_tag="$1" docker_platform="$2" key="$3"
  echo "==> integration tests against $image_tag ($docker_platform)"
  (
    cd "$REPO_ROOT"
    INTEGRATION_SERVER_IMAGE="$image_tag" \
    INTEGRATION_SERVER_PLATFORM="$docker_platform" \
      npm run test:integration
  )
}

verify_image() {
  local image_tag="$1" docker_platform="$2" key="$3"
  echo "==> verifying $image_tag (start + look for 'GraphQL API ready')"

  # Use a tmpfs-backed SQLite path so the read-only check doesn't depend on
  # bind-mount semantics under qemu, and so we don't litter the host fs.
  local cid log status=1
  cid="$(docker run -d \
    --platform "$docker_platform" \
    --rm \
    -e SQLITE_DB_PATH=/tmp/verify.db \
    -e RUST_LOG=info \
    "$image_tag")"

  # Give qemu-emulated startup up to 30s; native arm hosts will be much faster.
  for _ in $(seq 1 30); do
    log="$(docker logs "$cid" 2>&1 || true)"
    if echo "$log" | grep -q "GraphQL API ready"; then
      status=0
      break
    fi
    if ! docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null | grep -q true; then
      break
    fi
    sleep 1
  done

  log="$(docker logs "$cid" 2>&1 || true)"
  docker kill "$cid" >/dev/null 2>&1 || true

  if (( status == 0 )); then
    echo "    ok: $key binary starts under ${docker_platform}"
  else
    echo "    FAIL: $key did not log 'GraphQL API ready' within 30s" >&2
    echo "--- container log ---" >&2
    echo "$log" >&2
    echo "--- end log ---" >&2
    exit 1
  fi
}

for t in "${REQUESTED[@]}"; do
  build_target "$t"
done

echo
echo "all done. artifacts in $DIST_DIR/"
ls -lh "$DIST_DIR"
