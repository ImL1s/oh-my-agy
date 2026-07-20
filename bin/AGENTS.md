<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# bin

## Purpose

CLI entry source for `oma` / `omy`. Compiled by `tsc` to `dist/bin/oma.js` (package `bin` field).

## Key Files

| File | Description |
|------|-------------|
| `oma.ts` | Process entry — wires application, dual path structured vs pass-through |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- Keep entry thin: parse + dispatch into `src/cli/application.ts`.
- Do not put business logic here.

### Testing Requirements

- Covered indirectly via `tests/cli/*` and e2e spawning `dist/bin/oma.js`.

### Common Patterns

- Shebang / Node entry after compile

## Dependencies

### Internal

- `src/cli/*`

### External

- Node runtime

<!-- MANUAL: -->
