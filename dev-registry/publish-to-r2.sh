#!/bin/bash
# Publishes dev-registry/ (index.json + packages/*.pmplugin) to the R2 bucket
# backing the production registry Function (functions/registry/[[path]].ts).
#
# Run this after `node dev-registry/build-index.mjs` any time a plugin's
# version changes — it's the "deploy" step for the registry, independent of
# the app's own build/deploy.
#
# Usage: dev-registry/publish-to-r2.sh <bucket-name>
set -euo pipefail
cd "$(dirname "$0")"

BUCKET="${1:?usage: publish-to-r2.sh <bucket-name>}"

echo "uploading index.json..."
npx wrangler r2 object put "$BUCKET/index.json" --file=index.json --content-type=application/json --remote

shopt -s nullglob
for f in packages/*.pmplugin; do
  name="$(basename "$f")"
  echo "uploading packages/$name..."
  npx wrangler r2 object put "$BUCKET/packages/$name" --file="$f" --content-type=application/octet-stream --remote
done

echo "done."
