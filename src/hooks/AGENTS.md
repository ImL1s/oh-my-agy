<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# hooks

## Purpose

Antigravity plugin lifecycle entrypoints: PreInvocation (allow + optional skill inject) and Stop (continuation decision). Compiled to `dist/src/hooks/*.js` referenced by `hooks.json`.

## Key Files

| File | Description |
|------|-------------|
| `pre-invocation.ts` | Fail-open allow; inject skill protocol when managed binding present |
| `stop.ts` | Stop hook → continuation / allow JSON |
| `common.ts` | Shared hook I/O helpers |
| `workspace.ts` | Resolve hook workspace from env/paths |
| `debug-log.ts` | Fingerprinted debug logging (no raw nonce) |

## For AI Agents

### Working In This Directory

- Fail-open when identity incomplete — never block host hard.
- Only PreInvocation + Stop are public package hooks (no PostInvocation without ADR).
- Skill injection uses `<<<OMA_SKILL_PROTOCOL>>>` markers outside task delimiters.

### Testing Requirements

`tests/hooks/*`, e2e managed stop scenarios.

## Dependencies

### Internal

- `src/continuation/*`, `src/modes/skill-protocol.ts`, `src/runtime/*`

<!-- MANUAL: -->
