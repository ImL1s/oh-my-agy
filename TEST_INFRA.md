# Test Infrastructure

OMA uses Jest with `ts-jest`; suites run serially to avoid contention over Git,
tmux, state roots, plugin fixtures, and process signals.

## Test layers

| Layer | Location | Purpose |
|---|---|---|
| Unit/contract | `tests/**` | Runtime, continuation, hooks, setup, team, workflows, MCP, wiki, HUD, notifications, parity/release schemas |
| CLI E2E | `e2e/**` | Black-box binary routing, managed/legacy argv, stdin/stdout, signals, continuation, mock `agy` |
| Package | `tests/package/**` | Packed files, compiled entrypoints, plugin/skill/MCP/workflow manifests, version sync |
| Smoke | `scripts/smoke.sh` | Build plus broad test/package/readback checks |
| Production | `oma production verify` | Fresh live evidence for the exact candidate commit |

Fixtures use temporary repositories, HOME/state/config roots, mock `agy`, and
isolated tmux/worktree identifiers. Process tests use condition-based readiness
markers rather than fixed sleeps where practical. External execution uses argv
arrays, never a shell string.

## Commands

```bash
npm ci
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
```

Run a targeted suite while iterating:

```bash
npx jest --config jest.unit.config.js --runInBand tests/workflows
npx jest --config jest.config.js --runInBand e2e/structured-cli.spec.ts
```

The package test calls `npm pack --dry-run --ignore-scripts`; `prepack` builds
but must not recurse through package tests.

## Production evidence

`npm run test:production` is not expected to pass in an ordinary checkout. It
requires fresh schema-v1 evidence bound to `git rev-parse HEAD` for installed
plugin discovery, managed lifecycle, exact resume, worker runtime, MCP/LSP,
workflow replay/review, independent code review, and UltraQA. With any evidence
missing or stale, expected output includes `E_PRODUCTION_EVIDENCE` and exit 1.

Never convert that fail-closed result into a skipped or green test. Deterministic
green tests establish `implementation_verified`, not `production_verified`.

## Cleanup and safety

Tests must leave no tmux session, child process, worktree, plugin-registry
mutation, or test-owned temporary directory behind. Circuit-breaker tests must
prove user work is preserved; destructive Git rollback is forbidden.
