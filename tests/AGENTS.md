<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# tests

## Purpose

Unit / integration tests for OMA TypeScript modules. Jest + ts-jest via `jest.unit.config.js`, always `--runInBand` to avoid shared-state races.

## Key Files

| File | Description |
|------|-------------|
| (none at root) | Specs live in subdirs |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `cli/` | Parser, application, managed invocation, directives, skills CLI |
| `hooks/` | Stop decision, managed stop, workspace resolution |
| `runtime/` | State store, locks, process runner, breaker, sandbox |
| `setup/` | Doctor, host-install, plugin preflight, setup transaction |
| `autopilot/` | Commands, phases, runtime FSM |
| `team/` | Orchestrator, deliver, lease, reclaim, tmux, worktree |
| `modes/` | Skill surface packaging |
| `package/` | plugin.json / pack surface contracts |
| `helpers/` | Shared fixtures (git, hooks, process, state, tmux) |

## For AI Agents

### Working In This Directory

- Name specs `*.spec.ts`; co-locate by product area matching `src/`.
- Use helpers under `helpers/` instead of ad-hoc temp dirs when possible.
- Mock host CLIs (claude/grok) via injectable adapters — never real plugin install in unit tests.

### Testing Requirements

```bash
npm run test:unit
npx jest --config jest.unit.config.js --runInBand tests/setup/host-install.spec.ts
```

### Common Patterns

- Isolated temp dirs + cleanup in `finally`
- Condition-based waits over fixed sleeps
- Assert absolute symlink targets for skill links

## Dependencies

### Internal

- Imports from `src/**` (not `dist/`)

### External

- Jest 29, ts-jest

<!-- MANUAL: -->
