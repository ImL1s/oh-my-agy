#!/usr/bin/env bash
# OMA one-shot local install: build + PATH hint + agy plugin setup
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> oh-my-agy install (repo root: $ROOT)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found (need >=20)" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "error: Node $NODE_MAJOR < 20" >&2
  exit 1
fi

echo "==> npm ci"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "==> npm run build"
npm run build

BIN_DIR="${OMA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/dist/bin/oma.js" "$BIN_DIR/oma"
ln -sfn "$ROOT/dist/bin/oma.js" "$BIN_DIR/omy"
chmod +x "$ROOT/dist/bin/oma.js" 2>/dev/null || true
echo "==> symlinked oma/omy -> $BIN_DIR"
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo "warn: add to PATH: export PATH=\"$BIN_DIR:\$PATH\"" >&2
fi

if command -v agy >/dev/null 2>&1; then
  echo "==> oma setup (agy plugin validate/install/enable)"
  if command -v oma >/dev/null 2>&1; then
    oma setup || node "$ROOT/dist/bin/oma.js" setup
  else
    node "$ROOT/dist/bin/oma.js" setup
  fi
  echo "==> oma doctor"
  node "$ROOT/dist/bin/oma.js" doctor || true
else
  echo "warn: agy not on PATH — skip plugin setup. Install Antigravity CLI then run: oma setup" >&2
fi

echo "==> done"
echo "    try: oma --help"
echo "    managed: oma ralph -- \"your task\""
