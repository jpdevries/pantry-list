#!/bin/bash
set -e

# Run from the repo root regardless of how the script is invoked.
# Cloudflare Workers Builds runs build commands from the package
# directory in monorepos (despite the dashboard's "Path: /" setting),
# so without this cd the `npm run build --workspace=…` below would
# fail to locate the workspaces.
cd "$(git rev-parse --show-toplevel)"

echo "🏗️  Building @pantry-host/web..."
npm run build --workspace=@pantry-host/web

echo "✅ Build complete"
