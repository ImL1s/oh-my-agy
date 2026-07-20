<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# runtime

## Purpose

Shared infrastructure: state root resolution, revisioned state store, owner-safe locks, process runner with caps, sandbox helpers, typed errors, Result types, atomic renames.

## Key Files

| File | Description |
|------|-------------|
| `types.ts` | `Result`, ok/err helpers |
| `errors.ts` | `RuntimeError` codes |
| `state-root.ts` | Platform / env state root (owner-only) |
| `state-store.ts` | CAS revisioned JSON store |
| `lock.ts` | Owner-safe lock reclaim with dead-process proof |
| `process.ts` | Bounded spawn, output limits, descendant caps |
| `atomic.ts` | Temp + fsync + rename patterns |
| `sandbox.ts` | Planning sandbox gate (ADR-0001 related) |

## For AI Agents

### Working In This Directory

- Reject symlink escape / path traversal into state root.
- Locks: contenders cannot delete live owner lock.
- Process runner: overflow kills child, not silent truncate-only.

### Testing Requirements

`tests/runtime/*` — heavy coverage of safety contracts.

## Dependencies

### External

- Node fs/process; optional sandbox tool when required

<!-- MANUAL: -->
