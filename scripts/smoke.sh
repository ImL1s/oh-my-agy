#!/usr/bin/env bash
# Hermetic smoke (no live agy model). Exit non-zero on hard failures.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run build
npm run test:unit
npm run test:package

test -f dist/bin/oma.js
test -f dist/src/hooks/pre-invocation.js
test -f dist/src/hooks/stop.js

node dist/bin/oma.js --help | grep -q 'ralph --'
node dist/bin/oma.js --version

PACK="$(npm pack --silent)"
trap 'rm -f "$PACK"' EXIT
tar -tzf "$PACK" | grep -E 'package/dist/src/hooks/(pre-invocation|stop)\.js' >/dev/null
tar -tzf "$PACK" | grep -E 'package/(plugin|hooks)\.json' >/dev/null

echo "smoke OK: $PACK"
