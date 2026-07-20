#!/usr/bin/env bash
# OMA install: build + PATH + multi-host setup (agy + Claude/Grok slash skills)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> oh-my-agy install (repo root: $ROOT)"
echo "    primary UX: session slash /oh-my-agy:autopilot"

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

OMA_BIN=node
if command -v oma >/dev/null 2>&1; then
  OMA_BIN=oma
fi

echo "==> multi-host setup (agy + claude/grok slash surface)"
if [[ "$OMA_BIN" == "oma" ]]; then
  oma setup || node "$ROOT/dist/bin/oma.js" setup
else
  node "$ROOT/dist/bin/oma.js" setup
fi

echo "==> doctor"
node "$ROOT/dist/bin/oma.js" doctor --no-strict-plugin || true

echo "==> done"
echo "    PRIMARY: restart Claude Code / Grok, then:  /oh-my-agy:autopilot <goal>"
echo "    optional ledger: oma autopilot start -- \"<goal>\""
echo "    help: oma --help | oma skill list"
