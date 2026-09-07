#!/usr/bin/env bash
# Build this plugin with the host's `instatic-plugin` CLI.
#
# The CLI lives inside an Instatic checkout, so point INSTATIC at yours:
#   INSTATIC=/path/to/Instatic scripts/build.sh lint
#   INSTATIC=/path/to/Instatic scripts/build.sh build
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-build}"
INSTATIC="${INSTATIC:-}"
if [[ -z "$INSTATIC" || ! -d "$INSTATIC" ]]; then
  echo "error: set INSTATIC to your Instatic checkout (it hosts the plugin CLI)" >&2
  exit 2
fi
# Everything below happens on a COPY, so the repo is never mutated.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$REPO/." "$WORK/"
rm -rf "$WORK/.git" "$WORK/dist"

# 1. The SDK has no published package, so point vendor-sdk.ts at the CLI's
#    own checkout.
SDK="$INSTATIC/src/core/plugin-sdk/index.ts"
if [[ ! -f "$SDK" ]]; then
  echo "error: no plugin SDK at $SDK — is INSTATIC an Instatic checkout?" >&2
  exit 2
fi
cat > "$WORK/vendor-sdk.ts" <<SDKPATCH
export * from '$SDK'
SDKPATCH

# 2. Unit tests import 'bun:test', which the CLI's sandbox scan forbids in
#    the plugin tree — and they do not belong in a shipped zip either.
find "$WORK" -type d -name '__tests__' -prune -exec rm -rf {} +

# 3. UPSTREAM GAP: the pinned `definePlugin` builder silently DROPS the
#    manifest's `contentAccess` key, and the manifest validator then
#    rejects the result because a cms.content.* permission is granted
#    without it. Re-inject it through a thin wrapper config. Remove this
#    once upstream keeps the key.
mv "$WORK/instatic-plugin.config.ts" "$WORK/instatic-plugin.config.base.ts"
cat > "$WORK/instatic-plugin.config.ts" <<'WRAP'
import definition from './instatic-plugin.config.base'

if (definition.manifest.permissions.some((p) => p.startsWith('cms.content.'))) {
  definition.manifest.contentAccess = [{ table: 'pages', modes: ['read'] }]
}

export default definition
WRAP

# 4. UPSTREAM GAP: the CLI zips only what IT wrote to dist/, while the
#    manifest's frontend.assets[] resolve against the extracted zip. Seed
#    dist/assets for the lint check, then append assets/ to the artifact
#    after the build.
mkdir -p "$WORK/dist/assets"
cp "$WORK/assets/tracker.js" "$WORK/dist/assets/tracker.js"

cd "$INSTATIC"
bun instatic-plugin "$MODE" "$WORK"

if [[ "$MODE" == "build" ]]; then
  mkdir -p "$WORK/dist"
  cp -R "$WORK/assets" "$WORK/dist/assets"
  (cd "$WORK/dist" && zip -qr "$WORK.plugin.zip" assets)
  rm -rf "$REPO/dist"
  cp -R "$WORK/dist" "$REPO/dist"
  cp "$WORK.plugin.zip" "$REPO/vantage-seo.plugin.zip"
  echo "built -> $REPO/dist and $REPO/vantage-seo.plugin.zip"
fi
