---
name: setup
description: "Install/enable OMA plugin hooks and verify with doctor"
---

# setup (OMA)

## Purpose

Make OMA actually active inside Antigravity: CLI on PATH + plugin hooks enabled.

## Steps

```bash
# from clone
./scripts/install.sh
# or
npm ci && npm run build
oma setup
oma doctor
```

## Expectations

- `oma doctor` checks Node ≥20, dist hooks, package/plugin version sync, agy on PATH, state root, plugin registry (strict by default).
- `npm i -g` alone does **not** enable hooks — always run `oma setup` (or `agy plugin install/enable`).

## Skills after setup

Plugin `skills/` directory ships workflow protocols (`autopilot`, `ralph`, …). Managed launches inject skill protocol into the prompt; also read skills when the host surfaces them.
