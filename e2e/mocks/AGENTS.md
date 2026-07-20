<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# mocks

## Purpose

Test doubles for external host CLI (`agy`) so e2e does not need a real Antigravity login.

## Key Files

| File | Description |
|------|-------------|
| `agy` | Executable mock replacing `agy` on PATH during tests |

## For AI Agents

### Working In This Directory

- Keep mock behavior minimal and deterministic.
- Do not call real network services.

### Testing Requirements

Used by `e2e/*.spec.ts` via helper PATH injection.

<!-- MANUAL: -->
