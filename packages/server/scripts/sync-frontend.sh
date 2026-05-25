#!/usr/bin/env bash
# Mirror the latest Rex production build into packages/server/static/ so
# rust-embed picks it up the next time `cargo build` runs.
#
# Run this whenever packages/app changes; the populated `static/` dir is
# gitignored, so each release-build cycle is:
#
#   cd packages/app && npm run build       (produces .rex/build/client/*)
#   packages/server/scripts/sync-frontend.sh
#   cargo build --release -p pantry-server
#
# build-pi.sh wraps the whole sequence.
#
# Flags:
#   --build   Run `npm run build` in packages/app first (default: assume
#             you've already built and just want to mirror).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
INSTALLER_UI_DIR="$REPO_ROOT/packages/installer-ui"

DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if (( DO_BUILD )); then
  echo "==> rex build (packages/app)"
  ( cd "$APP_DIR" && npm run build )
  echo "==> vite build (packages/installer-ui)"
  ( cd "$INSTALLER_UI_DIR" && npm run build )
fi

REX_CLIENT="$APP_DIR/.rex/build/client"
REX_MANIFEST="$APP_DIR/.rex/build/manifest.json"
APP_PUBLIC="$APP_DIR/public"
STATIC_CLIENT="$SERVER_DIR/static/client"
STATIC_PUBLIC="$SERVER_DIR/static/public"

if [[ ! -d "$REX_CLIENT" || ! -f "$REX_MANIFEST" ]]; then
  echo "error: rex build output not found." >&2
  echo "       expected $REX_CLIENT and $REX_MANIFEST" >&2
  echo "       run: cd packages/app && npm run build  (or pass --build)" >&2
  exit 1
fi

echo "==> mirroring $REX_CLIENT -> $STATIC_CLIENT"
mkdir -p "$STATIC_CLIENT" "$STATIC_PUBLIC"
# Wipe stale chunks (build hashes change every build) but keep .gitkeep.
find "$STATIC_CLIENT" -mindepth 1 ! -name '.gitkeep' -delete
find "$STATIC_PUBLIC" -mindepth 1 ! -name '.gitkeep' -delete

cp -R "$REX_CLIENT"/. "$STATIC_CLIENT/"
# Drop sourcemaps to keep the embedded binary lean — they're ~3x the size of
# the JS itself and we don't need source-level debugging in a release Pi
# binary. The rust-embed `*.map` exclude also filters them at compile time,
# but skipping the copy means a quicker rebuild and a smaller artifact tree
# during development.
find "$STATIC_CLIENT" -name '*.map' -delete

# The frontend module reads manifest.json from inside the client/ embed.
cp "$REX_MANIFEST" "$STATIC_CLIENT/manifest.json"

# Public assets the binary needs to serve at the URL root. Only mirror the
# small set the SW + PWA care about — leaving uploads, logo-sketches, and
# _witness-init.html out of the embed keeps the binary smaller.
for f in favicon.ico icon-192.png icon-512.png manifest.json sw.js pear.png; do
  if [[ -f "$APP_PUBLIC/$f" ]]; then
    cp "$APP_PUBLIC/$f" "$STATIC_PUBLIC/$f"
  fi
done

CLIENT_BYTES=$(du -sk "$STATIC_CLIENT" | cut -f1)
PUBLIC_BYTES=$(du -sk "$STATIC_PUBLIC" | cut -f1)
echo "==> done. client=${CLIENT_BYTES} KB, public=${PUBLIC_BYTES} KB"
