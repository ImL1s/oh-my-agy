<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# scripts

## Purpose

Shell helpers for local install and smoke validation outside Jest.

## Key Files

| File | Description |
|------|-------------|
| `install.sh` | Build + PATH link + multi-host `oma setup` (slash-first banner) |
| `smoke.sh` | Lightweight smoke (unit/package/pack surface as configured) |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- Keep zsh/bash portable; no bash-only extensions if avoidable.
- Install script must emphasize `/oh-my-agy:autopilot` / agy `/autopilot` after restart.

### Testing Requirements

- Manual: `./scripts/install.sh`, `./scripts/smoke.sh`
- CI uses npm scripts primarily

### Common Patterns

- Fail fast with `set -euo pipefail` where appropriate

## Dependencies

### Internal

- Invokes `npm run build`, `node dist/bin/oma.js`

### External

- bash/zsh, node, optional claude/grok/agy on PATH

<!-- MANUAL: -->
