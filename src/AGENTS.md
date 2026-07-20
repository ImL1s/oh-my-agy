<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# src

## Purpose

All product TypeScript for OMA: CLI wiring, hooks, continuation aggregate, autopilot FSM, team orchestration, setup/host install, modes/skills protocol, and shared runtime primitives. Compiles to `dist/src/` and `dist/bin/`.

## Key Files

| File | Description |
|------|-------------|
| `enforcer.ts` | Legacy todo.json continuation + circuit breaker (no destructive git) |
| `types.ts` | Shared top-level type re-exports / contracts |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `cli/` | Parser, application, managed invocation, services (see `cli/AGENTS.md`) |
| `hooks/` | PreInvocation / Stop entrypoints (see `hooks/AGENTS.md`) |
| `continuation/` | Session aggregate + progress oracle (see `continuation/AGENTS.md`) |
| `autopilot/` | Durable five-phase FSM (see `autopilot/AGENTS.md`) |
| `team/` | Multi-worker orchestrator (see `team/AGENTS.md`) |
| `runtime/` | State root, locks, process, errors (see `runtime/AGENTS.md`) |
| `setup/` | Doctor, plugin transaction, slash host install (see `setup/AGENTS.md`) |
| `modes/` | Mode directives + skill loader/protocol (see `modes/AGENTS.md`) |
| `verification/` | Evidence / causal-trace validators (see `verification/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Prefer smallest module that owns the contract; do not grow `enforcer.ts` for new features.
- All external processes: `spawn`/`spawnSync` only.
- Design-mapping comments in zh-TW when porting OMC/OMX ideas.

### Testing Requirements

Mirror under `tests/<area>/*.spec.ts`. Run `npm run test:unit` after changes.

### Common Patterns

- `Result<T, RuntimeError>` for fallible APIs
- Revisioned CAS writes via `runtime/state-store`
- Fail-open hooks for PreInvocation when identity incomplete

## Dependencies

### Internal

- Consumed by `bin/oma.ts` and hook scripts
- Skills under `skills/` are docs; runtime skill injection via `modes/`

### External

- Node `child_process`, `fs`, `path`, `os` only (no framework)

<!-- MANUAL: -->
