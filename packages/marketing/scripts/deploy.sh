#!/bin/bash
set -e

# Run from the repo root regardless of how the script is invoked.
# Cloudflare Workers Builds runs build commands from the package
# directory in monorepos (despite the dashboard's "Path: /" setting),
# so without this cd `packages/marketing/...` path lookups below — and
# the `cd packages/marketing` near the end — would all break.
cd "$(git rev-parse --show-toplevel)"

# Conditional LFS fetch + R2 sync for Cloudflare Workers deploy.
#
# Videos are served from R2 (not from the build output), so we only
# need to fetch LFS files and sync to R2 when videos actually changed.
# This saves ~53 MB of LFS bandwidth per deploy — significant when
# pushing frequently against a 10 GB/month cap.
#
# The last deployed commit SHA is stored as a marker object in R2.
# On each deploy, we diff against that SHA to determine if any
# video files changed.

VIDEOS_PATH="packages/marketing/public/videos"
R2_BUCKET="pantry-host-videos"
MARKER_KEY=".last-deploy-sha"
CURRENT_SHA="${CF_PAGES_COMMIT_SHA:-$(git rev-parse HEAD)}"

echo "🔍 Current commit: $CURRENT_SHA"

# Try to read the last deploy SHA from R2
LAST_SHA=""
if command -v npx &>/dev/null; then
  LAST_SHA=$(npx wrangler r2 object get "$R2_BUCKET/$MARKER_KEY" --pipe 2>/dev/null || echo "")
fi

if [ -n "$LAST_SHA" ] && git cat-file -t "$LAST_SHA" &>/dev/null; then
  # Valid previous SHA — check for video changes
  CHANGED_FILES=$(git diff --name-only "$LAST_SHA" "$CURRENT_SHA" -- "$VIDEOS_PATH" 2>/dev/null || echo "")
  CHANGED_COUNT=$(echo "$CHANGED_FILES" | grep -c . 2>/dev/null || echo "0")

  if [ "$CHANGED_COUNT" = "0" ]; then
    echo "📦 No video changes since ${LAST_SHA:0:8} — skipping LFS fetch"
  else
    echo "🎬 $CHANGED_COUNT video file(s) changed — fetching from LFS"
    git lfs pull --include="$VIDEOS_PATH/**"

    # Sync changed files to R2
    echo "$CHANGED_FILES" | while IFS= read -r file; do
      [ -z "$file" ] && continue
      # R2 key is relative to the videos dir (e.g. "barcode.mp4")
      R2_KEY="${file#$VIDEOS_PATH/}"
      if [ -f "$file" ]; then
        echo "  ↑ Uploading $R2_KEY to R2"
        npx wrangler r2 object put "$R2_BUCKET/$R2_KEY" --file "$file" \
          --content-type "$(file --mime-type -b "$file" 2>/dev/null || echo 'application/octet-stream')"
      else
        echo "  ✗ $R2_KEY deleted (skipping R2 — manual cleanup needed)"
      fi
    done
  fi
else
  echo "🎬 No previous deploy SHA found — first deploy or marker missing"
  # Don't fetch LFS on first deploy either — videos should already
  # be in R2 from a manual upload. Only fetch if FORCE_LFS=1.
  if [ "${FORCE_LFS:-0}" = "1" ]; then
    echo "  FORCE_LFS=1 — fetching all LFS files"
    git lfs pull --include="$VIDEOS_PATH/**"
  else
    echo "  Skipping LFS fetch (set FORCE_LFS=1 to override)"
  fi
fi

# Build the marketing site
echo "🏗️  Building marketing site..."
cd packages/marketing
npx vite build

# Store current SHA as the deploy marker
echo "📌 Storing deploy SHA: ${CURRENT_SHA:0:8}"
echo -n "$CURRENT_SHA" | npx wrangler r2 object put "$R2_BUCKET/$MARKER_KEY" --pipe \
  --content-type "text/plain" 2>/dev/null || echo "  ⚠️  Failed to store deploy SHA (non-fatal)"

echo "✅ Deploy complete"
